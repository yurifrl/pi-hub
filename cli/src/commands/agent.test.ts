import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ agent: () => ({ ok: true, result: { started: true, name: "hub-agent" } }) });
});
afterAll(() => hub.close());

test("agent writes surface.json and emits snapshot", async () => {
  const r = await hub.run("agent", ["--json", "--surface", "pending"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual({ started: true, name: "hub-agent", surface: "pending" });
  const p = join(hub.home, ".hub", "agents", "hub-agent", "surface.json");
  expect(existsSync(p)).toBe(true);
  expect(JSON.parse(readFileSync(p, "utf8")).surface).toBe("pending");
});
