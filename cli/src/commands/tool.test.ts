import { afterAll, beforeAll, expect, test } from "bun:test";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ list: listHandler, tool: (req) => ({ ok: true, result: { got: req.args } }) });
});
afterAll(() => hub.close());

test("tool passes parsed json args", async () => {
  const r = await hub.run("tool", ["--json", "bbbb", "grep", '{"q":"x"}']);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual({
    ok: true,
    result: { got: { target: "bbbb3333-0000", tool: "grep", args: { q: "x" } } },
  });
});

test("tool invalid json -> usage exit 1", async () => {
  const r = await hub.run("tool", ["--json", "bbbb", "grep", "{nope"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("usage");
});

test("tool bad --wait -> usage exit 1", async () => {
  const r = await hub.run("tool", ["--json", "bbbb", "grep", "--wait", "0"]);
  expect(r.code).toBe(1);
});
