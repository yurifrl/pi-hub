import { afterAll, beforeAll, expect, test } from "bun:test";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ list: listHandler, assign: () => ({ ok: true, result: {} }) });
});
afterAll(() => hub.close());

test("assign <id> <task...>", async () => {
  const r = await hub.run("assign", ["--json", "bbbb", "fix", "the", "bug"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual({
    assigned: true,
    id: "bbbb3333-0000",
    sessionId: "bbbb3333-0000",
    task: "fix the bug",
  });
  expect(hub.calls.find((c) => c.op === "assign")?.args).toEqual({ id: "bbbb3333-0000", task: "fix the bug" });
});

test("assign unknown id -> not_found exit 1", async () => {
  const r = await hub.run("assign", ["--json", "nope", "x"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("not_found");
});

test("assign without args and no terminal -> usage exit 1", async () => {
  const r = await hub.run("assign", ["--json"]);
  expect(r.code).toBe(1);
});
