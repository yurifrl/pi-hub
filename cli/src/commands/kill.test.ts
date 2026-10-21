import { afterAll, beforeAll, expect, test } from "bun:test";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({
    list: listHandler,
    kill: () => ({ ok: true, result: { closedAt: "2026-10-21T10:00:00.000Z" } }),
  });
});
afterAll(() => hub.close());

test("kill --yes with unique prefix", async () => {
  const r = await hub.run("kill", ["--json", "--yes", "aaaa2"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual({
    killed: true,
    id: "aaaa2222-0000",
    archivedTo: "archive/2026-10/aaaa2222-0000.json",
  });
});

test("kill ambiguous prefix -> ambiguous exit 1 with candidates", async () => {
  const r = await hub.run("kill", ["--json", "--yes", "aaaa"]);
  expect(r.code).toBe(1);
  const env = JSON.parse(r.stdout);
  expect(env.error.code).toBe("ambiguous");
  expect(env.error.detail).toEqual(["aaaa1111-0000", "aaaa2222-0000"]);
});

test("kill without --yes and no tty -> usage exit 1, nothing killed", async () => {
  const before = hub.calls.filter((c) => c.op === "kill").length;
  const r = await hub.run("kill", ["--json"]);
  expect(r.code).toBe(1);
  expect(hub.calls.filter((c) => c.op === "kill").length).toBe(before);
});
