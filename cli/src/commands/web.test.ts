import { expect, test } from "bun:test";
import { startStubHub } from "../stub_hub";

test("web --json -> usage exit 1", async () => {
  const hub = await startStubHub({});
  const r = await hub.run("web", ["--json"]);
  await hub.close();
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.message).toContain("web");
});

test("web --port invalid -> usage exit 1", async () => {
  const hub = await startStubHub({});
  const r = await hub.run("web", ["--port", "nope"]);
  await hub.close();
  expect(r.code).toBe(1);
  expect(r.stderr + r.stdout).toContain("--port");
});

test("web serves the console on 127.0.0.1 and exits 0 on SIGINT", async () => {
  const hub = await startStubHub({});
  const proc = Bun.spawn(["bun", `${import.meta.dir}/../stub_runner.ts`, "web", "--port", "0"], {
    env: { PATH: process.env.PATH ?? "", HOME: hub.home, OMP_HUB_SOCK: hub.sock },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let out = "";
  const end = Date.now() + 8000;
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(out) && Date.now() < end) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
  expect(m).not.toBeNull();
  const res = await fetch(`http://127.0.0.1:${m![1]}/no-such-route`);
  expect(res.status).toBe(404); // server is live; "/" needs a status.json that a fresh data root lacks
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(0);
  await hub.close();
});
