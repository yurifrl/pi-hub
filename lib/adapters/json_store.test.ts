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

  it("valid file round-trips every field, unknown fields tolerated at every level", async () => {
    const root = await makeRoot();
    await Bun.write(
      join(root, "status.json"),
      seedStatus({
        digest: "tilt needs approval",
        futureField: { x: 1 },
        sessions: { "s-1": { phase: "working", futureSessionField: true } },
        attention: [{ kind: "approval", futureItemField: 7 }],
      }),
    );
    const r = await createJsonStore(root).read();
    expect(r.ok).toBe(true);
    if (r.ok) {
      const raw = r.value as unknown as Record<string, unknown>;
      expect(r.value.version).toBe(1);
      expect(r.value.nextAttentionId).toBe(8);
      expect(raw.digest).toBe("tilt needs approval");
      expect(raw.futureField).toEqual({ x: 1 });
      const session = (r.value.sessions["s-1"] ?? {}) as Record<string, unknown>;
      expect(session.futureSessionField).toBe(true);
      const item = (r.value.attention[0] ?? {}) as Record<string, unknown>;
      expect(item.futureItemField).toBe(7);
    }
  });

  it("torn/invalid file → error Result (no silent reset)", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "status.json"), '{"version":1,"sessions":{'); // torn
    const r = await createJsonStore(root).read();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("invalid JSON");
  });

  it("object without a version field → error Result", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "status.json"), JSON.stringify({ startedAt: "T0" }));
    const r = await createJsonStore(root).read();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("missing version");
  });
});

describe("json_store — atomic update", () => {
  it("update mutates and persists the whole object", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "status.json"), seedStatus());
    const store = createJsonStore(root);
    const r = await store.update((s) => ({ ...s, nextAttentionId: s.nextAttentionId + 1 }));
    expect(r.ok).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "status.json"), "utf8")) as Record<string, unknown>;
    expect(raw.nextAttentionId).toBe(9);
    expect(raw.sessions).toEqual({});
  });

  it("serialized file starts with the version field (meta block invariant)", async () => {
    const root = await makeRoot();
    const store = createJsonStore(root);
    await store.update((s) => ({ ...s, startedAt: "T0", pid: 42 }));
    const text = (await readFile(join(root, "status.json"), "utf8")).trimStart();
    expect(text).toMatch(/^\{\s*"version":/); // version is the first field of the meta block
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

  it("unknown fields survive an update (writers never remove fields within a version)", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "status.json"), seedStatus({ futureTop: "keep" }));
    const store = createJsonStore(root);
    const r = await store.update((s) => ({ ...s, pid: 2 }));
    expect(r.ok).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "status.json"), "utf8")) as Record<string, unknown>;
    expect(raw.futureTop).toBe("keep");
  });

  it("concurrent update() calls serialize; every write is a complete object", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "status.json"), seedStatus({ nextAttentionId: 0 }));
    const store = createJsonStore(root);
    // each mutation reads the committed file, so increments compose
    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.update((s) => ({ ...s, nextAttentionId: s.nextAttentionId + 1 }))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "status.json"), "utf8")) as Record<string, unknown>;
    expect(raw.nextAttentionId).toBe(25);
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

  it("a throwing mutate never corrupts the file nor throws across the port", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "status.json"), seedStatus({ pid: 7 }));
    const store = createJsonStore(root);
    const r = await store.update(() => {
      throw new Error("mutate blew up");
    });
    expect(r.ok).toBe(false);
    // the chain survives: the next update still works
    const next = await store.update((s) => ({ ...s, pid: 8 }));
    expect(next.ok).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "status.json"), "utf8")) as Record<string, unknown>;
    expect(raw.pid).toBe(8);
    await expect(Bun.file(join(root, "status.json.tmp")).exists()).resolves.toBe(false);
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

describe("json_store — error taxonomy", () => {
  it("errors are HubError values: unavailable-hub, non-retryable for a corrupt file", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "status.json"), "{oops");
    const r = await createJsonStore(root).read();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unavailable-hub");
      expect(r.error.retryable).toBe(false);
      expect(typeof r.error.message).toBe("string");
    }
  });
});
