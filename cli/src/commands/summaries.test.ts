import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStubHub, type StubHub } from "../stub_hub";

let hub: StubHub;
const row = (t: string, sessionId: string, kind: string, text: string, by: string): string =>
  JSON.stringify({ t, sessionId, kind, text, by });

beforeAll(async () => {
  hub = await startStubHub({});
  const dir = join(hub.home, ".hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "summaries.jsonl"),
    [
      row("2026-10-20T10:00:00.000Z", "aaaa1111-0000", "summary", "one", "agent"),
      row("2026-10-20T10:01:00.000Z", "bbbb2222-0000", "resolution", "two", "plugin"),
      "not json",
      row("2026-10-20T10:02:00.000Z", "aaaa1111-0000", "summary", "three", "agent"),
    ].join("\n") + "\n",
  );
});
afterAll(() => hub.close());

test("summaries --json: snapshot with all lines, invalid line skipped", async () => {
  const r = await hub.run("summaries", ["--json"]);
  expect(r.code).toBe(0);
  const env = JSON.parse(r.stdout);
  expect(env.type).toBe("snapshot");
  expect(env.data.lines.map((l: { text: string }) => l.text)).toEqual(["one", "two", "three"]);
});

test("summaries --tail N keeps the last N", async () => {
  const r = await hub.run("summaries", ["--json", "--tail", "2"]);
  expect(JSON.parse(r.stdout).data.lines.map((l: { text: string }) => l.text)).toEqual(["two", "three"]);
});

test("summaries <prefix> filters to one session", async () => {
  const r = await hub.run("summaries", ["--json", "aaaa"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data.lines.map((l: { text: string }) => l.text)).toEqual(["one", "three"]);
});

test("summaries --tail 0 -> usage exit 1", async () => {
  const r = await hub.run("summaries", ["--json", "--tail", "0"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ type: "error", error: { code: "usage" } });
});

test("summaries unknown id -> not_found exit 1", async () => {
  const r = await hub.run("summaries", ["--json", "zzzz"]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error.code).toBe("not_found");
});

test("summaries --ndjson: one snapshot per row", async () => {
  const r = await hub.run("summaries", ["--ndjson"]);
  const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ type: "snapshot", data: { text: "one" } });
});

test("summaries human: time, by and text rendered, no ANSI when piped", async () => {
  const r = await hub.run("summaries", ["--no-color"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("▎");
  expect(r.stdout).toContain("agent one");
  expect(r.stdout).toContain("plugin two");
  expect(r.stdout).not.toContain("\x1b");
});

test("summaries with no file -> empty lines", async () => {
  const empty = await startStubHub({});
  const r = await empty.run("summaries", ["--json"]);
  await empty.close();
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).data.lines).toEqual([]);
});
