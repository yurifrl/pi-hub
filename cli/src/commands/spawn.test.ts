import { afterAll, beforeAll, expect, test } from "bun:test";
import { startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ spawn: (req) => ({ ok: true, result: { name: (req.args.name as string) ?? "w1" } }) });
});
afterAll(() => hub.close());

test("spawn --name --model", async () => {
  const r = await hub.run("spawn", ["--json", "--name", "bob", "--model", "m1"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual({ name: "bob", model: "m1" });
  expect(hub.calls.find((c) => c.op === "spawn")?.args).toEqual({ name: "bob", model: "m1" });
});

test("spawn model falls back to OMP_HUB_MODEL", async () => {
  const r = await hub.run("spawn", ["--json"], { OMP_HUB_MODEL: "envm" });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data.model).toBe("envm");
});

test("hub unreachable -> exit 2", async () => {
  const r = await hub.run("spawn", ["--json"], { OMP_HUB_SOCK: `${hub.home}/nope.sock` });
  expect(r.code).toBe(2);
});
