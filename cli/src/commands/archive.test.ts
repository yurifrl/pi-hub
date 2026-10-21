import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ list: listHandler, archive: () => ({ ok: true, result: { archived: true, path: "archive/2026-10/x.json" } }) });
  const dir = join(hub.home, ".hub", "archive", "2026-10");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.json"), JSON.stringify({ id: "old", closedAt: "2026-10-01T00:00:00.000Z", closedBy: "cli", finalSummary: "a" }));
  writeFileSync(join(dir, "new.json"), JSON.stringify({ id: "new", closedAt: "2026-10-09T00:00:00.000Z", closedBy: "web", finalSummary: "b" }));
  writeFileSync(join(dir, "broken.json"), "{");
});
afterAll(() => hub.close());

test("archive (no id) lists from disk newest first, skipping broken files", async () => {
  const r = await hub.run("archive", ["--json"]);
  expect(r.code).toBe(0);
  const ids = JSON.parse(r.stdout).data.entries.map((e: { id: string }) => e.id);
  expect(ids).toEqual(["new", "old"]);
});

test("archive empty dir -> empty entries", async () => {
  const empty = await startStubHub({});
  const r = await empty.run("archive", ["--json"]);
  await empty.close();
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data.entries).toEqual([]);
});

test("archive <id> resolves prefix", async () => {
  const r = await hub.run("archive", ["--json", "bbbb"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual({ archived: true, id: "bbbb3333-0000", path: "archive/2026-10/x.json" });
  expect(hub.calls.find((c) => c.op === "archive")?.args).toEqual({ sessionId: "bbbb3333-0000" });
});
