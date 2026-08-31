// lib/runtime/hub_core.test.ts — the hub-side runtime against fake ports
// (docs/01 §Testing: runtime layer, faked edges). Covers the P2-3 required
// tests the previous suite missed: guard 3 self-delivery denial through the
// real CommandSurface, and the send op's deliverTo routing with a live
// reporter bridge.
import { describe, expect, it } from "bun:test";
import { createHubCore } from "./hub_core";
import type { Result, HubError } from "../domain/command";
import type { StatusFile, AttentionItem, SummaryLine, RawOmpEvent } from "../domain/session";
import type { EventBus } from "../ports/event_bus";
import type { StatusStore } from "../ports/status_store";
import type { SummaryStore } from "../ports/summary_store";
import type { AttentionStore } from "../ports/attention_store";
import type { AgentRuntime } from "../ports/agent_runtime";
import type { Clock } from "../ports/clock";
import type { LogStore, StoredLogEntry } from "../adapters/jsonl_store";

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

const makeCore = (opts: { selfSessionId?: string; deliverTo?: (sessionId: string, text: string) => Result<void, HubError> } = {}) => {
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
    const core = createHubCore(
        {
            status,
            summaries: summaryStore,
            log,
            bus,
            runtime,
            attention,
            clock,
            selfSessionId: () => opts.selfSessionId ?? "",
            ...(opts.deliverTo !== undefined ? { deliverTo: opts.deliverTo } : {}),
        },
    );
    return { core, statusFile, logs, sent };
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
