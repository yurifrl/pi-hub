import { afterAll, beforeAll, expect, test } from "bun:test";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ list: listHandler, send: () => ({ ok: true, result: {} }) });
});
afterAll(() => hub.close());

test("send <id> <msg...> joins words", async () => {
  const r = await hub.run("send", ["--json", "bbbb", "hello", "there"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual({ sent: true, sessionId: "bbbb3333-0000", text: "hello there" });
  expect(hub.calls.find((c) => c.op === "send")?.args).toEqual({ target: "bbbb3333-0000", text: "hello there" });
});

test("send ambiguous id -> exit 1", async () => {
  const r = await hub.run("send", ["--json", "aaaa", "hi"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("ambiguous");
});

test("send with one arg and no terminal -> usage exit 1", async () => {
  const r = await hub.run("send", ["--json"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("usage");
});
