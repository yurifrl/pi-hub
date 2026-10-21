import { afterAll, beforeAll, expect, test } from "bun:test";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ list: listHandler, answer: () => ({ ok: true, result: {} }) });
});
afterAll(() => hub.close());

test("answer resolves attention prefix and emits snapshot", async () => {
  const r = await hub.run("answer", ["--json", "a-", "yes", "please"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({
    type: "snapshot",
    data: { answered: true, id: "a-1", sessionId: "aaaa1111-0000" },
  });
  const call = hub.calls.find((c) => c.op === "answer");
  expect(call?.args).toEqual({ id: "a-1", text: "yes please" });
});

test("answer unknown item -> not_found exit 1", async () => {
  const r = await hub.run("answer", ["--json", "zzz", "x"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("not_found");
});

test("answer without text -> usage exit 1", async () => {
  const r = await hub.run("answer", ["--json", "a-1"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("usage");
});
