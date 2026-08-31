// lib/adapters/attention_store.test.ts — the REAL AttentionStore over the real
// JSON stores, not a fake reimplementation (REJECT P2-3: the watcher tests used
// a fake store that reimplemented guard 6, so the real rejection never ran).
// Covers the real raise path: guard-6 selfId rejection, selfId rejections that
// never touch status.json, and the P3 unwarmed-cache footgun (list() warms
// itself on first call).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatusAttentionStore } from "./attention_store";
import { createJsonStore } from "./json_store";
import { createJsonlStore } from "./jsonl_store";
import type { StatusFile } from "../domain/session";

const tmps: string[] = [];
const makeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-att-"));
    tmps.push(dir);
    return dir;
};
afterAll(async () => {
    for (const dir of tmps) await rm(dir, { recursive: true, force: true });
});

const makeStore = (selfIds: () => string[]) => {
    const root = makeRoot();
    return root.then((dir) => {
        const status = createJsonStore(dir);
        const summaries = createJsonlStore(dir);
        const attention = createStatusAttentionStore({ status, summaries, clock: { now: () => 1_000_000 }, selfIds });
        return { status, attention };
    });
};

const emptyStatus = (): StatusFile => ({
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    pid: 1,
    nextAttentionId: 1,
    sessions: {},
    attention: [],
    archived: [],
});

describe("attention_store (real stores) — guard 6 + raise/list", () => {
    it("guard 6: raise for the hub agent's own session → denied, status.json untouched", async () => {
        const { status, attention } = await makeStore(() => ["s-agent-self"]);
        // warm the status file with the canonical skeleton
        await status.update(() => emptyStatus());

        const res = await attention.raise({ sessionId: "s-agent-self", kind: "approval", text: "approve the thing?", evidence: [] });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error.code).toBe("denied");
            expect(res.error.message).toContain("hub agent itself");
        }

        // the rejection never wrote an item (docs/05 §Anti-recursion guard 6)
        const snap = await status.read();
        if (snap.ok) expect(snap.value.attention).toEqual([]);
    });

    it("selfIds is resolved at call time: an id added after construction is still rejected", async () => {
        let selfId = "";
        const { status, attention } = await makeStore(() => (selfId ? [selfId] : []));
        await status.update(() => emptyStatus());

        // the watcher adopts the agent session id mid-flight (agentSession lands)
        selfId = "agent-adopted-late";

        const res = await attention.raise({ sessionId: "agent-adopted-late", kind: "question", text: "which target?", evidence: [] });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("denied");
    });

    it("raise for a peer session lands an open item; list() sees it (cache warm)", async () => {
        const { status, attention } = await makeStore(() => ["s-agent-self"]);
        await status.update(() => emptyStatus());

        const res = await attention.raise({ sessionId: "s-peer", kind: "approval", text: "approve deploy canary", evidence: [] });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.value.sessionId).toBe("s-peer");
            expect(res.value.id).toBe("att-1");
        }
        const listed = attention.list();
        expect(listed.ok).toBe(true);
        if (listed.ok) expect(listed.value.map((i) => i.sessionId)).toEqual(["s-peer"]);
    });

    it("raise is idempotent per (session, kind) while open: text updated, id stable, no duplicate", async () => {
        const { status, attention } = await makeStore(() => []);
        await status.update(() => emptyStatus());

        const a = await attention.raise({ sessionId: "s-peer", kind: "approval", text: "first text", evidence: [] });
        const b = await attention.raise({ sessionId: "s-peer", kind: "approval", text: "second text", evidence: [] });
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) expect(b.value.id).toBe(a.value.id);
        const snap = await status.read();
        if (snap.ok) {
            expect(snap.value.attention).toHaveLength(1);
            expect(snap.value.attention[0]!.text).toBe("second text");
        }
    });
});
