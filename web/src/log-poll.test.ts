// web/src/log-poll.test.ts — the JSON log poll endpoint (docs/04 §Session
// detail: the client's ?since= cursor net tails the log over JSON, not the
// HTML page) + the parseSince cursor vocabulary. Complements the pure
// renderer tests (detail-page.test.ts) and route shapes (server.test.ts).
// The live-HTTP suite proves the validator-repro: an epoch-ms string cursor
// must narrow to strictly-newer entries (pre-fix Date.parse widened to all).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AttentionStore, CommandSurface, EventBus, StatusFile, StatusStore, SummaryStore } from "@yurifrl/hub";
import { startHubWeb } from "./server";
import { parseSince, toLogViewEntries } from "./snapshot";
import type { DiskLogLine } from "./snapshot";
import type { HubWebDeps, HubWebLogs } from "./types";

// ---- fixtures: disk log lines (docs/02 shape, t = UTC string) ----

const LINES: DiskLogLine[] = [
  { t: "2026-08-30T14:02:00.000Z", kind: "system", text: "session_start attached=true" },
  { t: "2026-08-30T14:03:00.000Z", kind: "prompt", text: "deploy canary to staging" },
  { t: "2026-08-30T14:04:00.000Z", kind: "tool", text: "gh api /repos/x/y", meta: { tool: "Bash" } },
  { t: "2026-08-30T14:05:00.000Z", kind: "result", text: "200 ok", meta: { tool: "Bash", ok: true, durationMs: 800 } },
  { t: "2026-08-30T14:06:00.000Z", kind: "message", text: "canary deployed" },
];

// ---- pure: parseSince cursor vocabulary ----

describe("parseSince — ?since= cursor vocabulary", () => {
  it("accepts epoch-ms number-strings (the client's cursor unit)", () => {
    expect(parseSince("1756572000000")).toBe(1756572000000);
  });

  it("accepts UTC strings (the disk t shape)", () => {
    expect(parseSince("2026-08-30T14:03:00.000Z")).toBe(Date.parse("2026-08-30T14:03:00.000Z"));
  });

  it("no cursor → undefined; garbage → null", () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince("yesterday")).toBeNull();
    expect(parseSince("")).toBeNull();
  });
});

// ---- pure: toLogViewEntries numeric filtering ----

describe("toLogViewEntries — strictly-newer over mixed cursor vocabularies", () => {
  it("epoch-ms string cursor narrows to strictly-newer entries (t numeric, epoch ms)", () => {
    const since = String(Date.parse("2026-08-30T14:03:00.000Z"));
    const out = toLogViewEntries(LINES, since);
    expect(out.map((e) => e.text)).toEqual(["gh api /repos/x/y", "200 ok", "canary deployed"]);
    expect(out.every((e) => typeof e.t === "number")).toBe(true);
  });

  it("cursor entry itself is excluded (strictly newer)", () => {
    const out = toLogViewEntries(LINES, String(Date.parse("2026-08-30T14:03:00.000Z")));
    expect(out.map((e) => e.text)).not.toContain("deploy canary to staging");
  });

  it("UTC string cursor keeps working", () => {
    const out = toLogViewEntries(LINES, "2026-08-30T14:03:00.000Z");
    expect(out.map((e) => e.text)).toEqual(["gh api /repos/x/y", "200 ok", "canary deployed"]);
  });

  it("invalid cursor → empty set (never the widened set)", () => {
    expect(toLogViewEntries(LINES, "1756572000000xyz")).toEqual([]);
  });

  it("no cursor → everything, bounded, with epoch-ms t", () => {
    const out = toLogViewEntries(LINES);
    expect(out.length).toBe(LINES.length);
    expect(out[0]!.t).toBe(Date.parse(LINES[0]!.t));
  });
});

// ---- live HTTP: GET /api/session/:id/log ----

const STATUS: StatusFile = {
  version: 1,
  startedAt: new Date(0).toISOString(),
  pid: process.pid,
  nextAttentionId: 1,
  sessions: {
    tilt: {
      status: "open", kind: "peer", cwd: "/w", title: "deploy canary", model: "m", phase: "working",
      log: "logs/tilt.jsonl", toolCounts: {}, turns: 1,
      startedAt: "2026-08-30T14:02:00.000Z", lastActivity: "2026-08-30T14:06:00.000Z",
    },
  },
  attention: [],
  archived: [],
};

const logs: HubWebLogs = {
  tail: async (id: string, since?: string) => {
    if (id !== "tilt") return [];
    if (since === undefined) return LINES.map((l) => ({ ...l, sessionId: id }));
    const floor = parseSince(since);
    if (floor === null || floor === undefined) return LINES;
    return LINES.filter((l) => Date.parse(l.t) > floor).map((l) => ({ ...l, sessionId: id }));
  },
} as unknown as HubWebLogs;

describe("GET /api/session/:id/log — JSON poll endpoint over HTTP", () => {
  let stop: (() => Promise<void>) | null = null;
  let port = 0;
  const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

  beforeAll(async () => {
    const statusStore: StatusStore = { read: async () => ({ ok: true, value: STATUS }), update: async () => ({ ok: false, error: { code: "denied", message: "ro", retryable: false } }) };
    const summaries: SummaryStore = { append: async () => ({ ok: true, value: undefined }), tail: async () => ({ ok: true, value: [] }) };
    const attention: AttentionStore = {
      list: () => ({ ok: true, value: [] }),
      raise: async () => ({ ok: false, error: { code: "denied", message: "x", retryable: false } }),
      resolve: async () => ({ ok: false, error: { code: "denied", message: "x", retryable: false } }),
    };
    const bus: EventBus = { publish: () => {}, subscribe: () => () => {} };
    const commands: CommandSurface = { dispatch: async () => ({ ok: true, value: null }), ops: () => [] };
    const deps: HubWebDeps = { port: 0, stores: { status: statusStore, summaries, attention }, bus, commands, logs };
    const one = await startHubWeb(deps);
    stop = one.stop;
    port = one.port;
  });
  afterAll(async () => {
    await stop?.();
  });

  it("returns {entries:[LogViewEntry,...]} JSON — epoch-ms t, no sessionId leak", async () => {
    const res = await fetch(url("/api/session/tilt/log"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body: any = await res.json();
    expect(Object.keys(body)).toEqual(["entries"]);
    expect(body.entries.length).toBe(LINES.length);
    expect(body.entries[0]).toEqual({ t: Date.parse(LINES[0]!.t), kind: "system", text: "session_start attached=true" });
  });

  it("epoch-ms string cursor over HTTP returns only the 3 strictly-newer lines (validator repro: was all-6 pre-fix)", async () => {
    const since = String(Date.parse("2026-08-30T14:03:00.000Z"));
    const res = await fetch(url(`/api/session/tilt/log?since=${since}`));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.entries.map((e: { text: string }) => e.text)).toEqual(["gh api /repos/x/y", "200 ok", "canary deployed"]);
  });

  it("UTC string cursor over HTTP still works", async () => {
    const res = await fetch(url("/api/session/tilt/log?since=2026-08-30T14:03:00.000Z"));
    const body: any = await res.json();
    expect(body.entries.map((e: { text: string }) => e.text)).toEqual(["gh api /repos/x/y", "200 ok", "canary deployed"]);
  });

  it("invalid cursor → 400 with error JSON", async () => {
    const res = await fetch(url("/api/session/tilt/log?since=yesterday"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid since cursor" });
  });

  it("unknown session → 200 with empty entries (a fresh tail, not an error)", async () => {
    const res = await fetch(url("/api/session/ghost/log"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [] });
  });

  it("POST → 405 with Allow: GET", async () => {
    const res = await fetch(url("/api/session/tilt/log"), { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
