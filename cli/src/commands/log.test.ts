import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStubHub, type StubHub } from "../stub_hub";

const ID = "aaaa1111-0000";
let hub: StubHub;
let logFile: string;
const entry = (n: number, kind = "tool"): string =>
  JSON.stringify({ t: `2026-10-20T10:00:0${n}.000Z`, sessionId: ID, kind, text: `msg ${n}` }) + "\n";

beforeAll(async () => {
  hub = await startStubHub({});
  const dir = join(hub.home, ".hub", "logs");
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, `${ID}.jsonl`);
  writeFileSync(logFile, entry(1) + entry(2, "message") + "garbage\n" + entry(3));
});
afterAll(() => hub.close());

test("log <prefix> --json: snapshot with entries, garbage skipped", async () => {
  const r = await hub.run("log", ["--json", "aaaa"]);
  expect(r.code).toBe(0);
  const env = JSON.parse(r.stdout);
  expect(env.type).toBe("snapshot");
  expect(env.data.sessionId).toBe(ID);
  expect(env.data.entries.map((e: { text: string }) => e.text)).toEqual(["msg 1", "msg 2", "msg 3"]);
});

test("log --tail N keeps the last N", async () => {
  const r = await hub.run("log", ["--json", "--tail", "1", ID]);
  expect(JSON.parse(r.stdout).data.entries.map((e: { text: string }) => e.text)).toEqual(["msg 3"]);
});

test("log --tail 0 -> usage", async () => {
  const r = await hub.run("log", ["--json", "--tail", "0", ID]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("usage");
});

test("log --ndjson: one snapshot per entry", async () => {
  const r = await hub.run("log", ["--ndjson", ID]);
  const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ type: "snapshot", data: { kind: "message", text: "msg 2" } });
});

test("log human: hue bar, kind and text, no ANSI with --no-color", async () => {
  const r = await hub.run("log", ["--no-color", ID]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("▎");
  expect(r.stdout).toMatch(/\d\d:\d\d:\d\d tool\s+msg 1/);
  expect(r.stdout).not.toContain("\x1b");
});

test("log unknown id -> not_found 1; no id and no TTY -> usage 1", async () => {
  const a = await hub.run("log", ["--json", "zzzz"]);
  expect(a.code).toBe(1);
  expect(JSON.parse(a.stdout).error.code).toBe("not_found");
  const b = await hub.run("log", ["--json"]);
  expect(b.code).toBe(1);
  expect(JSON.parse(b.stdout).error.code).toBe("usage");
});

test("log --json -f -> usage", async () => {
  const r = await hub.run("log", ["--json", "-f", ID]);
  expect(r.code).toBe(1);
});

test("log -f follows appends, survives truncate and rotate, SIGINT exits 0", async () => {
  const file = join(hub.home, ".hub", "logs", "follow0-0000.jsonl");
  writeFileSync(file, entry(1));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "stub_runner.ts"), "log", "--ndjson", "-f", "follow0"], {
    env: { PATH: process.env.PATH ?? "", HOME: hub.home, OMP_HUB_SOCK: hub.sock },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const waiters = new Map<string, () => void>();
  const seen = new Set<string>();
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  void (async () => {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        const text = JSON.parse(p).data.text as string;
        seen.add(text);
        waiters.get(text)?.();
      }
    }
  })();
  // resolves when the follower prints `text`; a hang fails via the test timeout
  const until = (text: string): Promise<void> => {
    if (seen.has(text)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.set(text, resolve);
    return promise;
  };
  await until("msg 1");
  appendFileSync(file, entry(2));
  await until("msg 2");
  writeFileSync(file, entry(3)); // truncate: size drops below the read position
  await until("msg 3");
  renameSync(file, `${file}.1`); // rotate: new inode at the same path
  writeFileSync(file, entry(4));
  await until("msg 4");
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(0);
});
