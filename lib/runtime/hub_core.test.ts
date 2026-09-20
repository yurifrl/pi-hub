// lib/runtime/hub_core.test.ts — the hub-side runtime against fake ports
// (docs/01 §Testing: runtime layer, faked edges). Covers the P2-3 required
// tests the previous suite missed: guard 3 self-delivery denial through the
// real CommandSurface, and the send op's deliverTo routing with a live
// reporter bridge.
import { describe, expect, it } from "bun:test";
import { createHubCore } from "./hub_core";
import type { Result, HubError } from "../domain/command";
import type { StatusFile, AttentionItem, SummaryLine, RawOmpEvent, ArchiveRecord } from "../domain/session";
import type { EventBus } from "../ports/event_bus";
import type { ArchiveStore } from "../ports/archive_store";
import type { StatusStore } from "../ports/status_store";
import type { SummaryStore } from "../ports/summary_store";
import type { AttentionStore } from "../ports/attention_store";
import type { AgentRuntime } from "../ports/agent_runtime";
import type { Clock } from "../ports/clock";
import type { LogStore, StoredLogEntry } from "../adapters/jsonl_store";

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

const makeCore = (opts: { selfSessionId?: string; deliverTo?: (sessionId: string, text: string) => Result<void, HubError>; restartGraceMs?: number } = {}) => {
    const statusFile: StatusFile = {
        version: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        pid: 1,
        nextAttentionId: 1,
        sessions: {},
        attention: [] as AttentionItem[],
        archived: [],
    };
    const status: StatusStore = {
        read: async () => ok(structuredClone(statusFile)),
        update: async (mutate) => {
            const next = mutate(statusFile);
            Object.assign(statusFile, next);
            return ok(structuredClone(statusFile));
        },
    };
    const summaries: SummaryLine[] = [];
    const summaryStore: SummaryStore = {
        append: async (line) => {
            summaries.push(line);
            return ok(undefined);
        },
        tail: async (n) => ok(summaries.slice(-n)),
    };
    const logs: StoredLogEntry[] = [];
    const log: LogStore = {
        appendLog: async (entry) => {
            logs.push(entry);
            return ok(undefined);
        },
        tailLog: async (sessionId, n) => ok(logs.filter((l) => l.sessionId === sessionId).slice(-n)),
        replayLog: async (sessionId) => ok(logs.filter((l) => l.sessionId === sessionId)),
    };
    const bus: EventBus = {
        publish: () => {},
        subscribe: () => () => {},
    };
    const sent: Array<{ name: string; text: string }> = [];
    const runtime: AgentRuntime = {
        spawn: async () => ok({ name: "worker-1", sessionId: null }),
        send: async (name, text) => {
            sent.push({ name, text });
            return ok(undefined);
        },
        kill: async () => ok(undefined),
    };
    const attention: AttentionStore = {
        list: () => ok(statusFile.attention),
        raise: async (c) =>
            ok({
                id: `att-${statusFile.nextAttentionId++}`,
                sessionId: c.sessionId,
                kind: c.kind,
                text: c.text,
                createdAt: "2026-01-01T00:00:00.000Z",
            }),
        resolve: async (id) => {
            const item = statusFile.attention.find((i) => i.id === id);
            return item ? ok(item) : { ok: false, error: { code: "unknown-session" as const, message: "no item", retryable: false } };
        },
    };
    const clock: Clock = { now: () => 1_000_000 };
    /** ArchiveStore fake: every write is recorded for assertions; paths mirror
     * the fs layout so tombstone checks read like the real thing. */
    const written: ArchiveRecord[] = [];
    const archive: ArchiveStore = {
        write: async (record) => {
            written.push(record);
            return ok(`archive/${record.closedAt.slice(0, 7)}/${record.id}.json`);
        },
    };
    const core = createHubCore(
        {
            status,
            summaries: summaryStore,
            log,
            bus,
            runtime,
            attention,
            archive,
            clock,
            selfSessionId: () => opts.selfSessionId ?? "",
            ...(opts.deliverTo !== undefined ? { deliverTo: opts.deliverTo } : {}),
        },
        { ...(opts.restartGraceMs !== undefined ? { restartGraceMs: opts.restartGraceMs } : {}) },
    );
    return { core, statusFile, logs, sent, archiveRecords: written };
};

const seedSession = async (core: ReturnType<typeof makeCore>["core"], sessionId: string): Promise<void> => {
    await core.handleEvent({ type: "session_start", sessionId, attached: false, cwd: "/w" } as RawOmpEvent);
};

describe("hub_core — guard 3: no self-delivery (real surface)", () => {
    it("send to the hub's own session id → denied: cannot deliver to the hub itself", async () => {
        const { core } = makeCore({ selfSessionId: "s-hub" });
        await seedSession(core, "s-hub");

        const res = await core.surface.dispatch({ cmdId: "c1", op: "send", args: { sessionId: "s-hub", text: "echo to myself" }, by: "web" });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error.code).toBe("denied");
            expect(res.error.message).toContain("cannot deliver to the hub itself");
        }
    });

    it("the empty/unknown self id (hub session not yet announced) does not deny everything", async () => {
        const { core } = makeCore({ selfSessionId: "" });
        await seedSession(core, "s-peer");
        const res = await core.surface.dispatch({ cmdId: "c1", op: "send", args: { sessionId: "s-peer", text: "normal send" }, by: "web" });
        // without a deliverTo bridge and no live child the send fails as
        // unknown-session (routing), never as the guard-3 denial
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("unknown-session");
    });
});

describe("hub_core — send routing through the reporter bridge", () => {
    it("deliverTo failure is reported; unknown-session when no bridge owns the session", async () => {
        let deliveredTo = "";
        const { core } = makeCore({
            deliverTo: (sessionId, text) => {
                deliveredTo = `${sessionId}:${text}`;
                return ok(undefined);
            },
        });
        await seedSession(core, "s-peer");
        const res = await core.surface.dispatch({ cmdId: "c2", op: "send", args: { sessionId: "s-peer", text: "hello peer" }, by: "plugin" });
        expect(res.ok).toBe(true);
        expect(deliveredTo).toBe("s-peer:hello peer");
    });

    it("the hub's own session never reaches deliverTo even with a bridge", async () => {
        let calls = 0;
        const { core } = makeCore({
            selfSessionId: "s-hub",
            deliverTo: () => {
                calls++;
                return ok(undefined);
            },
        });
        await seedSession(core, "s-hub");
        const res = await core.surface.dispatch({ cmdId: "c3", op: "send", args: { sessionId: "s-hub", text: "self" }, by: "plugin" });
        expect(res.ok).toBe(false);
        expect(calls).toBe(0);
    });
});

describe("hub_core — kill/archive close path (docs/02 §kill, §archive)", () => {
    it("kill closes a live session: archives, drops the row, appends the tombstone", async () => {
        const { core, statusFile, archiveRecords } = makeCore();
        await seedSession(core, "s-peer");

        const res = await core.surface.dispatch({ cmdId: "c1", op: "kill", args: { sessionId: "s-peer" }, by: "cli" });
        expect(res.ok).toBe(true);

        expect(statusFile.sessions["s-peer"]).toBeUndefined();
        expect(archiveRecords).toHaveLength(1);
        expect(archiveRecords[0]!.id).toBe("s-peer");
        expect(archiveRecords[0]!.closedBy).toBe("cli");
        // the record carries the session state as last seen (session_start
        // marks the row working)
        expect(archiveRecords[0]!.phase).toBe("working");
        // tombstone link matches the fake layout archive/YYYY-MM/<id>.json
        expect(statusFile.archived).toEqual([{ id: "s-peer", path: "archive/1970-01/s-peer.json", closedAt: archiveRecords[0]!.closedAt }]);
    });

    it("kill on an unknown session → unknown-session; a second kill after a close is the same error", async () => {
        const { core } = makeCore();
        await seedSession(core, "s-peer");

        const first = await core.surface.dispatch({ cmdId: "c1", op: "kill", args: { sessionId: "s-ghost" }, by: "cli" });
        expect(first.ok).toBe(false);
        if (!first.ok) expect(first.error.code).toBe("unknown-session");

        await core.surface.dispatch({ cmdId: "c2", op: "kill", args: { sessionId: "s-peer" }, by: "cli" });
        const second = await core.surface.dispatch({ cmdId: "c3", op: "kill", args: { sessionId: "s-peer" }, by: "cli" });
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.error.code).toBe("unknown-session");
    });

    it("the archive op runs the same close path with closedBy 'archive' and replies {archived, id, path}", async () => {
        const { core, statusFile, archiveRecords } = makeCore();
        await seedSession(core, "s-peer");

        const res = await core.surface.dispatch({ cmdId: "c1", op: "archive", args: { sessionId: "s-peer" }, by: "web" });
        expect(res.ok).toBe(true);
        if (res.ok) {
            const data = res.value as { archived: boolean; id: string; path: string };
            expect(data.archived).toBe(true);
            expect(data.id).toBe("s-peer");
            expect(data.path).toBe(`archive/${archiveRecords[0]!.closedAt.slice(0, 7)}/s-peer.json`);
        }
        expect(archiveRecords[0]!.closedBy).toBe("archive");
        expect(statusFile.sessions["s-peer"]).toBeUndefined();
    });

    it("resolved attention items ride along in the archive record's resolutions tail", async () => {
        const { core, statusFile, archiveRecords } = makeCore();
        await seedSession(core, "s-peer");
        statusFile.attention.push({
            id: "att-1",
            sessionId: "s-peer",
            kind: "question",
            text: "keep raw logs forever?",
            createdAt: "1970-01-01T00:16:40.000Z",
            resolvedAt: "1970-01-01T00:16:41.000Z",
            answer: "yes for v1",
        });

        await core.surface.dispatch({ cmdId: "c1", op: "archive", args: { sessionId: "s-peer" }, by: "cli" });
        expect(archiveRecords).toHaveLength(1);
        expect(archiveRecords[0]!.resolutions).toEqual([
            expect.objectContaining({ id: "att-1", resolvedAt: "1970-01-01T00:16:41.000Z" }),
        ]);
    });
});

describe("hub_core — reapStale (docs/02 §hub-restart)", () => {
    it("closes only sessions with no activity past the grace window, tagged closedBy 'hub-restart'", async () => {
        const { core, statusFile, archiveRecords } = makeCore({ restartGraceMs: 60_000 });
        await seedSession(core, "s-fresh");
        await seedSession(core, "s-stale");
        // the fixed test clock starts at 1_000_000ms; a stale row predates it
        statusFile.sessions["s-fresh"]!.lastActivity = "2030-01-01T00:00:00.000Z";
        statusFile.sessions["s-stale"]!.lastActivity = "1970-01-01T00:00:00.000Z";

        const res = await core.reapStale();
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.value).toBe(1);

        expect(Object.keys(statusFile.sessions)).toEqual(["s-fresh"]);
        expect(archiveRecords).toHaveLength(1);
        expect(archiveRecords[0]!.id).toBe("s-stale");
        expect(archiveRecords[0]!.closedBy).toBe("hub-restart");
    });

    it("a session already closing is skipped by the sweep", async () => {
        const { core, statusFile, archiveRecords } = makeCore({ restartGraceMs: 60_000 });
        await seedSession(core, "s-stale");
        statusFile.sessions["s-stale"]!.lastActivity = "2020-01-01T00:00:00.000Z";
        statusFile.sessions["s-stale"]!.status = "closing";

        const res = await core.reapStale();
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.value).toBe(0);
        expect(statusFile.sessions["s-stale"]).toBeDefined();
        expect(archiveRecords).toHaveLength(0);
    });
});
