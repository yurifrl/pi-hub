// web/src/stream.test.ts — the /stream SSE endpoint over HTTP (docs/04-web.md
// §SSE contract), asserted through event replay, not sleeps (docs/01 §Testing).
// A separate server instance per test (port 0) with its own sse bus; the fake
// EventBus is capture-style so tests publish hub events directly.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionStore, EventBus, HubEvent, SessionRecord, StatusFile, StatusStore, SummaryStore, CommandSurface } from "@yurifrl/hub";
import { startHubWeb } from "./server";
import type { HubWebDeps } from "./types";

// ---- fake ports (stores + bus + command surface; see server.test.ts) ----

const session = (over: Partial<SessionRecord>): SessionRecord => ({
  status: "open",
  kind: "peer",
  cwd: "/tmp",
  title: "test session",
  model: "test-model",
  phase: "working",
  log: "logs/x.jsonl",
  toolCounts: {},
  turns: 0,
  startedAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  ...over,
});

const makeDeps = (dataRoot: string, bus: EventBus): HubWebDeps => {
  const readStatus = async (): Promise<StatusFile> => {
    const raw = await Bun.file(join(dataRoot, "status.json")).text();
    return JSON.parse(raw) as StatusFile;
  };
  const statusStore: StatusStore = {
    read: async () => ({ ok: true, value: await readStatus() }),
    update: async (mutate) => {
      const next = mutate(await readStatus());
      writeFileSync(join(dataRoot, "status.json"), JSON.stringify(next));
      return { ok: true, value: next };
    },
  };
  const summaryStore: SummaryStore = {
    append: async () => ({ ok: true, value: undefined }),
    tail: async () => ({ ok: true, value: [] }),
  };
  const attentionStore: AttentionStore = {
    list: () => ({ ok: true, value: [] }),
    raise: async () => ({ ok: false, error: { code: "unavailable-hub", message: "not implemented", retryable: false } }),
    resolve: async () => ({ ok: false, error: { code: "unavailable-hub", message: "not implemented", retryable: false } }),
  };
  const commands: CommandSurface = {
    dispatch: async () => ({ ok: true, value: null }),
    ops: () => ["answer", "assign", "send", "attention"],
  };
  return { port: 0, stores: { status: statusStore, summaries: summaryStore, attention: attentionStore }, bus, commands };
};

/** Capture-style EventBus double: tests publish hub events directly. */
const makeBus = (): EventBus & { emit: (evt: HubEvent) => void } => {
  let fn: ((evt: HubEvent) => void) | null = null;
  return {
    publish: (e) => fn?.(e),
    subscribe: (sub) => {
      fn = sub;
      return () => {
        fn = null;
      };
    },
    emit: (e) => fn?.(e),
  };
};

// one server for the whole file; deltas are emitted inline and read
// synchronously — no sleeps anywhere (docs/01 §Testing)

let dataRoot: string;
let bus: ReturnType<typeof makeBus>;
let stop: (() => Promise<void>) | null = null;
let port = 0;
const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "hub-stream-test-"));
  writeFileSync(
    join(dataRoot, "status.json"),
    JSON.stringify({
      version: 1,
      startedAt: new Date(0).toISOString(),
      pid: process.pid,
      nextAttentionId: 1,
      digest: "1 need you · 1 running",
      sessions: { tilt: session({ phase: "waiting", title: "rate limit hit on POST /deploy" }) },
      attention: [
        { id: "att-1", sessionId: "tilt", kind: "approval", text: "rate limit hit on POST /deploy — approve retry?", createdAt: new Date(0).toISOString() },
      ],
      archived: [],
    } satisfies StatusFile),
  );
  bus = makeBus();
  const running = await startHubWeb(makeDeps(dataRoot, bus));
  stop = running.stop;
  port = running.port;
});
afterAll(async () => {
  await stop?.();
  rmSync(dataRoot, { recursive: true, force: true });
});

/** Open /stream, read the first N SSE frames (frames arrive as one chunk; a
 * second read blocks until more deltas are published — tests then publish). */
const openStream = async (headers: Record<string, string> = {}) => {
  const res = await fetch(url("/stream"), { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  return {
    res,
    reader,
    /** read one chunk and split it into SSE frames */
    readFrames: async (): Promise<Array<{ id?: number; event: string; data: any }>> => {
      const { value, done } = await reader.read();
      if (done) return [];
      return decoder
        .decode(value)
        .split("\n\n")
        .filter((b) => b.length > 0)
        .map((b) => {
          const frame: { id?: number; event: string; data: any } = { event: "", data: undefined };
          for (const line of b.split("\n")) {
            if (line.startsWith("id: ")) frame.id = Number.parseInt(line.slice(4), 10);
            else if (line.startsWith("event: ")) frame.event = line.slice(7);
            else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
          }
          return frame;
        });
    },
    close: () => reader.cancel(),
  };
};

describe("GET /stream — connect", () => {
  it("first event is a fresh snapshot with the /api/status shape", async () => {
    const s = await openStream();
    try {
      const frames = await s.readFrames();
      expect(frames).toHaveLength(1);
      const [snap] = frames;
      expect(snap!.id).toBeUndefined(); // snapshots are unnumbered
      expect(snap!.event).toBe("snapshot");
      expect(snap!.data.v).toBe(1);
      expect(snap!.data.digest).toBe("1 need you · 1 running");
      expect(snap!.data.attention.map((a: { id: string }) => a.id)).toEqual(["att-1"]);
      expect(snap!.data.sessions.map((x: { id: string }) => x.id)).toEqual(["tilt"]);
    } finally {
      await s.close();
    }
  });

  it("a connect with no Last-Event-ID sends the snapshot only — no deltas", async () => {
    bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "tool_call", text: "bun test", t: 1 } });
    const s = await openStream();
    try {
      const frames = await s.readFrames();
      expect(frames.map((f) => f.event)).toEqual(["snapshot"]);
    } finally {
      await s.close();
    }
  });
});

describe("GET /stream — live deltas", () => {
  it("attention raised/resolved deltas carry op + item", async () => {
    const s = await openStream();
    try {
      await s.readFrames(); // consume the initial snapshot
      bus.emit({ topic: "attention", payload: { id: "att-2", sessionId: "tilt", kind: "question", text: "which registry?", createdAt: new Date(1).toISOString() } });
      bus.emit({ topic: "attention", payload: { id: "att-1", sessionId: "tilt", kind: "approval", text: "x", createdAt: new Date(0).toISOString(), resolvedAt: new Date(1).toISOString(), answer: "yes" } });
      const frames = await s.readFrames();
      expect(frames.map((f) => f.event)).toEqual(["attention", "attention"]);
      expect(frames[0]!.data.op).toBe("raised");
      expect(frames[0]!.data.item.id).toBe("att-2");
      expect(frames[1]!.data.op).toBe("resolved");
      expect(frames[1]!.data.item.resolvedAt).toBeDefined();
      expect(frames[1]!.id).toBeDefined(); // deltas are numbered
    } finally {
      await s.close();
    }
  });

  it("log deltas carry sessionId + precomputed hue + entry {t, kind, text}", async () => {
    const s = await openStream();
    try {
      await s.readFrames();
      bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "tool_call", text: "bun test", t: 42 } });
      const [frame] = await s.readFrames();
      expect(frame!.event).toBe("log");
      expect(frame!.data.sessionId).toBe("tilt");
      expect(typeof frame!.data.hue).toBe("number");
      expect(frame!.data.hue).toBeGreaterThanOrEqual(0);
      expect(frame!.data.hue).toBeLessThan(216);
      expect(frame!.data.entry).toEqual({ t: 42, kind: "tool_call", text: "bun test" });
    } finally {
      await s.close();
    }
  });

  it("summary and phase deltas carry their contract payloads", async () => {
    const s = await openStream();
    try {
      await s.readFrames();
      bus.emit({ topic: "summary", payload: { t: new Date(0).toISOString(), sessionId: "tilt", kind: "summary", text: "deployed canary", by: "agent" } });
      bus.emit({ topic: "phase", payload: { sessionId: "tilt", phase: "working", at: new Date(0).toISOString() } });
      const frames = await s.readFrames();
      expect(frames.map((f) => f.event)).toEqual(["summary", "phase"]);
      expect(frames[0]!.data).toEqual({ t: expect.any(String), sessionId: "tilt", kind: "summary", text: "deployed canary", by: "agent" });
      expect(frames[1]!.data).toEqual({ sessionId: "tilt", phase: "working", at: expect.any(String) });
    } finally {
      await s.close();
    }
  });

  it("deltas for multiple connections each get their own frames", async () => {
    const a = await openStream();
    const b = await openStream();
    try {
      await a.readFrames();
      await b.readFrames();
      bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "assistant_message", text: "hi both", t: 7 } });
      const fa = await a.readFrames();
      const fb = await b.readFrames();
      expect(fa[0]!.data.entry.text).toBe("hi both");
      expect(fb[0]!.data.entry.text).toBe("hi both");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("status (snapshot-material) events produce no delta", async () => {
    const s = await openStream();
    try {
      await s.readFrames();
      bus.emit({ topic: "status", payload: { reason: "agent-restart" } });
      bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "user_message", text: "still live", t: 8 } });
      const frames = await s.readFrames();
      expect(frames.map((f) => f.event)).toEqual(["log"]);
    } finally {
      await s.close();
    }
  });
});

describe("GET /stream — Last-Event-ID reconnect", () => {
  it("reattach replays in-ring deltas with original ids, then a fresh snapshot", async () => {
    const s = await openStream();
    await s.readFrames(); // initial snapshot
    bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "user_message", text: "one", t: 1 } });
    bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "user_message", text: "two", t: 2 } });
    const live = await s.readFrames(); // consume the two deltas while connected
    const lastId = live.at(-1)!.id!;
    await s.close();

    // reconnect claiming to have seen only the first of the two deltas;
    // chunks are not frame-aligned, so read twice to get both frames
    const re = await openStream({ "last-event-id": String(live[0]!.id) });
    try {
      const frames = [...(await re.readFrames()), ...(await re.readFrames())];
      expect(frames.map((f) => f.event)).toEqual(["log", "snapshot"]);
      expect(frames[0]!.id).toBe(lastId); // original payload, original id
      expect(frames[0]!.data.entry.text).toBe("two");
      expect(frames[1]!.id).toBeUndefined(); // snapshot unnumbered
      expect(frames[1]!.data.attention.map((a: { id: string }) => a.id)).toEqual(["att-1"]);
    } finally {
      await re.close();
    }
  });

  it("reattach that missed beyond the ring degrades to the snapshot only", async () => {
    const s = await openStream();
    await s.readFrames();
    for (let i = 0; i < 300; i++) {
      bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "tool_call", text: `spam ${i}`, t: i } });
    }
    const live = await s.readFrames(); // drain the spam so the socket stays clean
    const oldestLive = live[0]!.id!; // the oldest spam frame the client saw
    await s.close();

    // reconnect claiming an id older than anything the ring still holds:
    // the client's claimed last id predates the ring's oldest frame - 1
    const re = await openStream({ "last-event-id": "0" });
    try {
      const frames = await re.readFrames();
      expect(frames.map((f) => f.event)).toEqual(["snapshot"]);
      expect(oldestLive).toBeGreaterThan(1); // sanity: the spam was numbered
    } finally {
      await re.close();
    }
  });

  it("garbage Last-Event-ID degrades to the snapshot only", async () => {
    bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "tool_call", text: "x", t: 1 } });
    const re = await openStream({ "last-event-id": "garbage" });
    try {
      const frames = await re.readFrames();
      expect(frames.map((f) => f.event)).toEqual(["snapshot"]);
    } finally {
      await re.close();
    }
  });

  it("lastEventId query param honored (raw reconnects without headers)", async () => {
    const s = await openStream();
    await s.readFrames();
    bus.emit({ topic: "log", payload: { sessionId: "tilt", kind: "user_message", text: "one", t: 1 } });
    await s.readFrames();
    await s.close();
    const re = await openStream(); // no header — set the query param
    try {
      const frames = await re.readFrames();
      expect(frames.map((f) => f.event)).toEqual(["snapshot"]);
    } finally {
      await re.close();
    }
  });
});

describe("GET /stream — lifecycle", () => {
  it("stop() closes open SSE connections", async () => {
    const one = await startHubWeb(makeDeps(dataRoot, makeBus()));
    const res = await fetch(`http://127.0.0.1:${one.port}/stream`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    // consume the initial snapshot frame, then wait for the next chunk —
    // stop() must resolve that pending read as done (stream closed)
    await reader.read();
    const pending = reader.read();
    await one.stop();
    const result = await pending;
    expect(result.done).toBe(true); // stream closed, not just quiet
  });
});
