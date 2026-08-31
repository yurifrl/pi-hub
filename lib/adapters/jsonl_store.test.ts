// lib/adapters/jsonl_store.test.ts — integration against temp dirs (docs/01
// §Testing: jsonl_store append/replay).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlStore, truncateLogText } from "./jsonl_store";
import type { SummaryLine } from "../domain/session";

const tmps: string[] = [];
const makeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-jsonl-"));
    tmps.push(dir);
    return dir;
};

afterAll(async () => {
    for (const dir of tmps) await rm(dir, { recursive: true, force: true });
});

const line = (i: number): SummaryLine => ({
    t: `2026-08-30T17:0${i}:00.000Z`,
    sessionId: "s-9f2c",
    kind: "summary",
    text: `cycle ${i}`,
    by: "agent",
});

describe("jsonl_store — SummaryStore.append/tail", () => {
    it("append creates summaries.jsonl; tail returns newest-last tail", async () => {
        const root = await makeRoot();
        const store = createJsonlStore(root);
        for (const i of [1, 2, 3]) {
            const r = await store.append(line(i));
            expect(r.ok).toBe(true);
        }
        const tail = await store.tail(2);
        expect(tail.ok).toBe(true);
        if (tail.ok) {
            expect(tail.value.map((l) => l.text)).toEqual(["cycle 2", "cycle 3"]);
        }
    });

    it("tail(n) with filter narrows before slicing", async () => {
        const root = await makeRoot();
        const store = createJsonlStore(root);
        await store.append(line(1));
        await store.append({ ...line(2), sessionId: "s-4a71" });
        await store.append(line(3));
        const tail = await store.tail(1, { id: "s-9f2c" });
        expect(tail.ok).toBe(true);
        if (tail.ok) expect(tail.value.map((l) => l.text)).toEqual(["cycle 3"]);
    });

    it("tail on a missing file is an empty ok, not an error", async () => {
        const tail = await createJsonlStore(await makeRoot()).tail(5);
        expect(tail.ok).toBe(true);
        if (tail.ok) expect(tail.value).toEqual([]);
    });
});

describe("jsonl_store — log append/replay (docs/02 ## logs)", () => {
    it("appendLog writes logs/<id>.jsonl; replay returns oldest-first", async () => {
        const root = await makeRoot();
        const store = createJsonlStore(root);
        for (const i of [1, 2]) {
            const r = await store.appendLog({ t: `2026-08-30T18:0${i}:00.000Z`, sessionId: "s-9f2c", kind: "message", text: `msg ${i}` });
            expect(r.ok).toBe(true);
        }
        const replay = await store.replayLog("s-9f2c");
        expect(replay.ok).toBe(true);
        if (replay.ok) {
            expect(replay.value).toHaveLength(2);
            expect(replay.value[0]?.text).toBe("msg 1");
            expect(replay.value[1]?.kind).toBe("message");
            expect(replay.value[0]?.sessionId).toBe("s-9f2c"); // denormalized: self-contained lines
        }
    });

    it("tailLog returns the last n entries, oldest of the tail first", async () => {
        const root = await makeRoot();
        const store = createJsonlStore(root);
        for (const i of [1, 2, 3, 4]) {
            await store.appendLog({ t: `t${i}`, sessionId: "s-x", kind: "prompt", text: `p${i}` });
        }
        const tail = await store.tailLog("s-x", 2);
        expect(tail.ok).toBe(true);
        if (tail.ok) expect(tail.value.map((e) => e.text)).toEqual(["p3", "p4"]);
    });

    it("tailLog filter narrows by kind and text before slicing", async () => {
        const root = await makeRoot();
        const store = createJsonlStore(root);
        await store.appendLog({ t: "t1", sessionId: "s-x", kind: "tool", text: "ran bun test", meta: { tool: "bash" } });
        await store.appendLog({ t: "t2", sessionId: "s-x", kind: "message", text: "hello" });
        await store.appendLog({ t: "t3", sessionId: "s-x", kind: "tool", text: "ran bun build" });
        const tail = await store.tailLog("s-x", 1, { kind: ["tool"] });
        if (tail.ok) expect(tail.value.map((e) => e.text)).toEqual(["ran bun build"]);
        const texts = await store.tailLog("s-x", 5, { text: "BUN" }); // case-insensitive
        if (texts.ok) expect(texts.value).toHaveLength(2);
    });

    it("replay on a missing session log is an empty ok", async () => {
        const r = await createJsonlStore(await makeRoot()).replayLog("s-absent");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual([]);
    });

    it("torn tail (last line without newline) is discarded on read; earlier lines survive", async () => {
        const root = await makeRoot();
        const store = createJsonlStore(root);
        await store.appendLog({ t: "t1", sessionId: "s-torn", kind: "system", text: "session_start" });
        await store.appendLog({ t: "t2", sessionId: "s-torn", kind: "prompt", text: "complete line" });
        // simulate a crash mid-append: partial JSON, no trailing newline
        await Bun.write(join(root, "logs", "s-torn.jsonl"), (await Bun.file(join(root, "logs", "s-torn.jsonl")).text()) + '{"t":"t3","session');
        const replay = await store.replayLog("s-torn");
        expect(replay.ok).toBe(true);
        if (replay.ok) {
            expect(replay.value).toHaveLength(2);
            expect(replay.value[1]?.text).toBe("complete line");
        }
        // the file is never rewritten: the torn bytes stay on disk
        const raw = await Bun.file(join(root, "logs", "s-torn.jsonl")).text();
        expect(raw.endsWith('{"t":"t3","session')).toBe(true);
    });

    it("append after a torn tail: O_APPEND keeps bytes, the merged line is skipped on read, complete lines survive", async () => {
        const root = await makeRoot();
        const store = createJsonlStore(root);
        await store.appendLog({ t: "t1", sessionId: "s-t2", kind: "system", text: "start" });
        const p = join(root, "logs", "s-t2.jsonl");
        await Bun.write(p, (await Bun.file(p).text()) + '{"t":"t2","sess'); // torn
        const r = await store.appendLog({ t: "t3", sessionId: "s-t2", kind: "message", text: "after tear" });
        expect(r.ok).toBe(true);
        // O_APPEND semantics: the new line glued onto the torn fragment (the
        // merged line is invalid JSON and is skipped on read forever; the
        // file is never rewritten)
        const replay = await store.replayLog("s-t2");
        if (replay.ok) expect(replay.value.map((e) => e.text)).toEqual(["start"]);
        const raw = await Bun.file(p).text();
        expect(raw).toContain('"text":"after tear"'); // bytes did land
    });

    it("truncateLogText caps at 2KB (writer-side helper)", () => {
        expect(truncateLogText("short")).toBe("short");
        const long = "x".repeat(3000);
        expect(truncateLogText(long)).toHaveLength(2048);
        expect(truncateLogText(long, 10)).toBe("xxxxxxxxxx");
    });
});
