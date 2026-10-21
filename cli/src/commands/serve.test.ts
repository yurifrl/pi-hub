import { expect, test } from "bun:test";
import { startStubHub } from "../stub_hub";

test("serve --json -> usage exit 1", async () => {
  const hub = await startStubHub({});
  const r = await hub.run("serve", ["--json"]);
  await hub.close();
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.message).toContain("serve");
});

test("serve against a live hub -> unavailable exit 2, live socket untouched", async () => {
  const hub = await startStubHub({ ping: () => ({ ok: true, result: { pong: true } }) });
  const r = await hub.run("serve", ["--json"].slice(1));
  expect(r.code).toBe(2);
  expect(r.stderr + r.stdout).toContain("already live");
  const ping = await hub.run("ping", []);
  await hub.close();
  expect(ping.code).not.toBe(2);
});
