import { afterAll, beforeAll, expect, test } from "bun:test";
import { startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
const body = {
  sessions: [{ id: "s1", status: "idle", title: "t", cwd: "/x", model: "m" }, { id: "d1", status: "detached", title: "q", cwd: "/y", model: "m" }],
  detached: ["old1"],
  errors: ["bad file"],
};
beforeAll(async () => {
  hub = await startStubHub({ sessions: () => ({ ok: true, result: body }) });
});
afterAll(() => hub.close());

test("sessions --json is verbatim rows", async () => {
  const r = await hub.run("sessions", ["--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data).toEqual(body);
});

test("sessions human: warnings on stderr, detached tail", async () => {
  const r = await hub.run("sessions", ["--no-color"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("warning: bad file");
  expect(r.stdout).toContain("detached (quiet): old1");
});

test("sessions scan failure -> exit 2", async () => {
  const bad = await startStubHub({ sessions: () => ({ ok: false, error: { code: "denied", message: "scan failed" } }) });
  const r = await bad.run("sessions", ["--json"]);
  await bad.close();
  expect(r.code).toBe(2);
  expect(JSON.parse(r.stdout).error.message).toBe("scan failed");
});
