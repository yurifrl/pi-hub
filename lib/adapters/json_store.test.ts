// lib/adapters/json_store.test.ts — integration against temp dirs (docs/01
// §Testing: json_store atomicity — interrupted write leaves status.json valid,
// tmp discarded).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonStore, removeStaleTmp } from "./json_store";

const tmps: string[] = [];
const makeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-json-store-"));
    tmps.push(dir);
    return dir;
};

afterAll(async () => {
    for (const dir of tmps) await rm(dir, { recursive: true, force: true });
});

const seedStatus = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
        version: 1,
        startedAt: "2026-08-30T17:42:10.113Z",
        pid: 43187,
        nextAttentionId: 8,
        sessions: {},
        attention: [],
        archived: [],
        ...overrides,
    });

describe("json_store — read", () => {
    it("missing file → error Result, not a throw", async () => {
        const store = createJsonStore(await makeRoot());
        const r = await store.read();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("unavailable-hub");
    });

    it("valid file round-trips every field, unknown fields tolerated", async () => {
        const root = await makeRoot();
        await Bun.write(join(root, "status.json"), seedStatus({ digest: "tilt needs approval", futureField: { x: 1 } }));
        const r = await createJsonStore(root).read();
        expect(r.ok).toBe(true);
        if (r.ok) {
            const raw = r.value as unknown as Record<string, unknown>;
            expect(r.value.version).toBe(1);
            expect(r.value.nextAttentionId).toBe(8);
            expect(raw.digest).toBe("tilt needs approval");
            expect(raw.futureField).toEqual({ x: 1 });
        }
    });

    it("torn/invalid file → error Result (no silent reset)", async () => {
        const root = await makeRoot();
        await Bun.write(join(root, "status.json"), '{"version":1,"sessions":{'); // torn
        const r = await createJsonStore(root).read();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.message).toContain("invalid JSON");
    });
});

describe("json_store — atomic update", () => {
    it("update mutates and persists the whole object", async () => {
        const root = await makeRoot();
        await Bun.write(join(root, "status.json"), seedStatus());
        const store = createJsonStore(root);
        const r = await store.update((s) => ({ ...s, nextAttentionId: s.nextAttentionId + 1 }));
        expect(r.ok).toBe(true);
        const raw = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
        expect(raw.nextAttentionId).toBe(9);
        expect(raw.sessions).toEqual({});
    });

    it("no tmp file remains after a successful write", async () => {
        const root = await makeRoot();
        await Bun.write(join(root, "status.json"), seedStatus());
        await createJsonStore(root).update((s) => ({ ...s, pid: 1 }));
        await expect(Bun.file(join(root, "status.json.tmp")).exists()).resolves.toBe(false);
    });

    it("missing file: update seeds from the skeleton (boot path)", async () => {
        const root = await makeRoot();
        const store = createJsonStore(root);
        const r = await store.update((s) => ({ ...s, startedAt: "T0", pid: 42 }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.startedAt).toBe("T0");
            expect(r.value.pid).toBe(42);
            expect(r.value.nextAttentionId).toBe(1);
            expect(r.value.sessions).toEqual({});
            expect(r.value.attention).toEqual([]);
        }
    });

    it("corrupt file: update is a hard error — no silent reset", async () => {
        const root = await makeRoot();
        await Bun.write(join(root, "status.json"), "not json at all");
        const store = createJsonStore(root);
        const r = await store.update((s) => ({ ...s, pid: 43 }));
        expect(r.ok).toBe(false);
        // file untouched
        await expect(readFile(join(root, "status.json"), "utf8")).resolves.toBe("not json at all");
    });
});

describe("json_store — atomicity under interrupted write (docs/01 §Testing)", () => {
    it("interrupted write leaves status.json valid, tmp discarded", async () => {
        const root = await makeRoot();
        const store = createJsonStore(root);
        await store.update((s) => ({ ...s, pid: 111 }));

        // Simulate a crash between tmp write and rename: put a torn tmp in place,
        // then verify the hub-side recovery (removeStaleTmp) + intact status.json.
        await Bun.write(join(root, "status.json.tmp"), '{"version":1,"start'); // torn tmp
        const before = await createJsonStore(root).read();
        expect(before.ok).toBe(true); // rename never happened → old object intact
        if (before.ok) expect(before.value.pid).toBe(111);

        const unlinked = await removeStaleTmp(root);
        expect(unlinked.ok).toBe(true);
        await expect(Bun.file(join(root, "status.json.tmp")).exists()).resolves.toBe(false);

        const after = await createJsonStore(root).read();
        expect(after.ok).toBe(true);
        if (after.ok) expect(after.value.pid).toBe(111);
    });

    it("rename(2) over an existing target preserves readers (last complete object wins)", async () => {
        const root = await makeRoot();
        const store = createJsonStore(root);
        await store.update((s) => ({ ...s, pid: 1 }));
        // concurrent-looking reader during rewrite sees a complete object
        const readPromise = store.read();
        await store.update((s) => ({ ...s, pid: 2 }));
        const r = await readPromise;
        expect(r.ok).toBe(true);
        if (r.ok) expect([1, 2]).toContain(r.value.pid);
    });
});

describe("removeStaleTmp", () => {
    it("ENOENT is a success — nothing to sweep", async () => {
        const r = await removeStaleTmp(await makeRoot());
        expect(r.ok).toBe(true);
    });
});
