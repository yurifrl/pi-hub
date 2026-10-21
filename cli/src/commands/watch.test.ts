import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHandler, startStubHub, type StubHub } from "../stub_hub";
import { createLoader, logRowsOf, transcriptRowsOf } from "./watch";

let hub: StubHub;
beforeAll(async () => {
  hub = await startStubHub({ list: listHandler });
  mkdirSync(join(hub.home, "logs"), { recursive: true });
  writeFileSync(
    join(hub.home, "logs", "aaaa1111-0000.jsonl"),
    [
      { t: "2026-10-21T10:00:00.000Z", sessionId: "aaaa1111-0000", kind: "prompt", text: "hello" },
      { t: "2026-10-21T10:00:01.000Z", sessionId: "aaaa1111-0000", kind: "message", text: "hi there" },
      { t: "2026-10-21T10:00:02.000Z", sessionId: "aaaa1111-0000", kind: "tool", text: "bash ls" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
});
afterAll(() => hub.close());

test("watch --json emits a snapshot envelope with selected chat and attention", async () => {
  const r = await hub.run("watch", ["--json"]);
  expect(r.code).toBe(0);
  const env = JSON.parse(r.stdout);
  expect(env.type).toBe("snapshot");
  expect(env.data.offline).toBe(false);
  expect(Array.isArray(env.data.chat)).toBe(true);
  expect(Array.isArray(env.data.attention)).toBe(true);
});

test("watch --json with the hub down degrades to offline, exit 0", async () => {
  const r = await hub.run("watch", ["--json"], { OMP_HUB_SOCK: join(hub.home, "nope.sock") });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data.offline).toBe(true);
});

test("watch piped human run prints one static frame", async () => {
  const r = await hub.run("watch", []);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("hub watch");
  expect(r.stdout).toContain("run hub watch in a terminal");
});

test("logRowsOf maps log kinds and skips junk", () => {
  const rows = logRowsOf('{"t":"x","kind":"prompt","text":"a"}\nnot json\n{"kind":"result","text":"z"}\n{"kind":"tool","text":"b"}');
  expect(rows.map((r) => r.kind)).toEqual(["user", "tool"]);
});

test("transcriptRowsOf translates omp transcript lines", () => {
  const lines = [
    { type: "message", timestamp: "2026-10-21T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "q" }] } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
  const rows = transcriptRowsOf("s", lines);
  expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "tool"]);
  expect(rows[2]?.text).toContain("bash");
});

test("loader lists roster first, then log-only extras; chat reads the hub log", () => {
  const root = mkdtempSync(join(tmpdir(), "watch-loader-"));
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "logs", "zzzz-extra.jsonl"), '{"t":"x","kind":"prompt","text":"hi"}\n');
  const loader = createLoader(root, join(root, "sessions"));
  const list = { hub: {}, sessions: { "r-1": { cwd: "/w/alpha", title: "alpha", phase: "idle", model: "m", kind: "worker" } } };
  const { rail } = loader.rail(list);
  expect(rail.map((r) => r.kind)).toEqual(["roster", "log"]);
  expect(rail[0]?.name).toBe("alpha");
  expect(loader.chat(rail[1])[0]?.text).toBe("hi");
});
