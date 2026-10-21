import { afterAll, beforeAll, expect, test } from "bun:test";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ list: listHandler });
});
afterAll(() => hub.close());

test("board --json emits one snapshot envelope with attention and running", async () => {
  const r = await hub.run("board", ["--json"]);
  expect(r.code).toBe(0);
  const env = JSON.parse(r.stdout);
  expect(Array.isArray(env.data.attention)).toBe(true);
  expect(Array.isArray(env.data.running)).toBe(true);
  expect(typeof env.data.orientation).toBe("string");
  expect(hub.calls.some((c) => c.op === "list")).toBe(true);
});

test("board --json excludes resolved attention items", async () => {
  const r = await hub.run("board", ["--json"]);
  const ids = JSON.parse(r.stdout).data.attention.map((a: { id: string }) => a.id);
  expect(ids).toContain("a-1");
  expect(ids).not.toContain("a-2");
});

test("board with no terminal prints one static frame", async () => {
  const r = await hub.run("board", []);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("run hub in a terminal for live view");
});
