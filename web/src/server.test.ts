// web/src/server.test.ts — routes via fetch against the running server on
// 127.0.0.1 with a TEMP data root (docs/01-architecture.md §Testing: web
// package level). Never touches the real ~/.hub.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionStore, EventBus, HubEvent, SessionRecord, StatusFile, StatusStore, SummaryStore, CommandSurface, CommandRequest, CommandReply } from "@yurifrl/hub";
import { startHubWeb } from "./server";
import type { HubWebDeps } from "./types";

// ---- temp data root (never the real ~/.hub) ----

let dataRoot: string;
beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "hub-web-test-"));
  const status: StatusFile = {
    version: 1,
    startedAt: new Date(0).toISOString(),
    pid: process.pid,
    nextAttentionId: 3,
    digest: "tilt needs approval · deploy canary 2/3 · docs idle 12m",
    sessions: {
      tilt: session({ phase: "waiting", title: "rate limit hit on POST /deploy" }),
      canary: session({ phase: "working", description: "deploy 2/3" }),
      docs: session({ phase: "idle" }),
      closed1: session({ status: "closing", phase: "idle" }),
    },
    attention: [
      {
        id: "att-1",
        sessionId: "tilt",
        kind: "approval",
        text: "rate limit hit on POST /deploy — approve retry?",
        createdAt: new Date(0).toISOString(),
      },
      {
        id: "att-2",
        sessionId: "docs",
        kind: "idle",
        text: "docs idle 12m — assign or kill",
        createdAt: new Date(0).toISOString(),
      },
      {
        id: "att-3",
        sessionId: "canary",
        kind: "question",
        text: "which registry for the new image?",
        createdAt: new Date(0).toISOString(),
        resolvedAt: new Date(1).toISOString(),
        answer: "ghcr",
      },
    ],
    archived: [],
  };
  writeFileSync(join(dataRoot, "status.json"), JSON.stringify(status));
});
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));

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

// ---- fake ports (stores + bus + command surface) ----

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

// bus recording subscriptions (stack — several servers live per test file)
const subscribers: Array<((evt: HubEvent) => void) | null> = [];
const bus: EventBus = {
  publish: () => {},
  subscribe: (fn) => {
    subscribers.push(fn);
    const idx = subscribers.length - 1;
    return () => {
      subscribers[idx] = null;
    };
  },
};

// command surface recording dispatch calls
type Call = { req: CommandRequest; reply: CommandReply };
const calls: Call[] = [];
const commands: CommandSurface = {
  dispatch: async (req) => {
    const reply: CommandReply =
      req.op === "answer"
        ? { ok: true, value: { answered: true, id: req.args.id } }
        : req.op === "attention" && req.args.action === "dismiss" && req.args.id === "ghost"
          ? { ok: false, error: { code: "unknown-session", message: "unknown item", retryable: false } }
          : { ok: true, value: null };
    calls.push({ req, reply });
    return reply;
  },
  ops: () => ["answer", "assign", "send", "attention"],
};

// ---- server under test ----

const deps: HubWebDeps = { port: 0, stores: { status: statusStore, summaries: summaryStore, attention: attentionStore }, bus, commands };
let stop: (() => Promise<void>) | null = null;
let port = 0;
const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

beforeAll(async () => {
  const running = await startHubWeb(deps);
  stop = running.stop;
  port = running.port;
});
afterAll(async () => {
  await stop?.();
});

// ---- routes ----

describe("GET /api/status", () => {
  it("returns the snapshot shape", async () => {
    const res = await fetch(url("/api/status"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body: any = await res.json();
    expect(body.v).toBe(1);
    expect(body.digest).toBe("tilt needs approval · deploy canary 2/3 · docs idle 12m");
    expect(body.attention.map((a: { id: string }) => a.id)).toEqual(["att-1", "att-2"]);
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["canary", "docs", "tilt"]);
  });

  it("synthesizes the orientation line when the hub agent is off", async () => {
    const raw = await readStatus();
    writeFileSync(join(dataRoot, "status.json"), JSON.stringify({ ...raw, digest: undefined }));
    const res = await fetch(url("/api/status"));
    const body: any = await res.json();
    expect(body.digest).toBe("2 need you · 2 running · 1 idle");
    // restore
    writeFileSync(join(dataRoot, "status.json"), JSON.stringify(raw));
  });

  it("carries no CORS headers", async () => {
    const res = await fetch(url("/api/status"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("POST /api/dismiss", () => {
  it("writes through the command surface", async () => {
    const res = await fetch(url("/api/dismiss"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: "att-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const last = calls.at(-1);
    expect(last?.req.op).toBe("attention");
    expect(last?.req.args).toEqual({ action: "dismiss", id: "att-1" });
    expect(last?.req.by).toBe("web");
  });

  it("maps unknown item to 404", async () => {
    const res = await fetch(url("/api/dismiss"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: "ghost" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown item" });
  });
});

describe("POST /api/answer", () => {
  it("delivers answer text through the command surface", async () => {
    const res = await fetch(url("/api/answer"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: "att-1", text: "approve retry" }),
    });
    expect(res.status).toBe(200);
    const last = calls.at(-1);
    expect(last?.req.op).toBe("answer");
    expect(last?.req.args).toEqual({ id: "att-1", text: "approve retry" });
  });
});

describe("POST /api/assign and /api/send", () => {
  it("assign goes through with {id, task}", async () => {
    const res = await fetch(url("/api/assign"), {
      method: "POST",
      body: JSON.stringify({ sessionId: "docs", task: "write docs" }),
    });
    expect(res.status).toBe(200);
    const last = calls.at(-1);
    expect(last?.req.op).toBe("assign");
    expect(last?.req.args).toEqual({ id: "docs", task: "write docs" });
  });

  it("send goes through with {target, text}", async () => {
    const res = await fetch(url("/api/send"), {
      method: "POST",
      body: JSON.stringify({ sessionId: "tilt", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const last = calls.at(-1);
    expect(last?.req.op).toBe("send");
    expect(last?.req.args).toEqual({ target: "tilt", text: "hello" });
  });
});

describe("malformed and missing bodies", () => {
  it("400 on malformed JSON", async () => {
    const res = await fetch(url("/api/dismiss"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
  });

  it("400 on missing itemId", async () => {
    const res = await fetch(url("/api/dismiss"), { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("HTML routes", () => {
  it("GET / renders the attention console", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("hub console");
    expect(body).toContain("tilt needs approval");
    expect(body).toContain("att-1");
  });

  it("GET /session/:id renders a known session", async () => {
    const res = await fetch(url("/session/tilt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("session tilt");
  });

  it("unknown session id → 404 page listing open sessions", async () => {
    const res = await fetch(url("/session/nope"));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("session not found");
    expect(body).toContain("tilt");
  });

  it("GET /agent, /archive, /archive/:id render 200", async () => {
    for (const path of ["/agent", "/archive", "/archive/closed1"]) {
      const res = await fetch(url(path));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("sets the v1 CSP on HTML pages", async () => {
    const res = await fetch(url("/"));
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    );
  });
});

describe("routing edge behavior", () => {
  it("404 unknown path", async () => {
    const res = await fetch(url("/definitely-not-here"));
    expect(res.status).toBe(404);
  });

  it("405 method mismatch with Allow header", async () => {
    const res = await fetch(url("/api/dismiss"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const res2 = await fetch(url("/api/status"), { method: "POST" });
    expect(res2.status).toBe(405);
    expect(res2.headers.get("allow")).toBe("GET");
  });
});

describe("GET /stream", () => {
  it("responds text/event-stream with an initial snapshot event", async () => {
    const one = await startHubWeb({ ...deps, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${one.port}/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      // read just the initial snapshot event bytes, then release the body
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value!);
      expect(text).toContain("event: snapshot");
      expect(text).toContain("\"v\":1");
      expect(text).toContain("\"attention\"");
      await reader.cancel();
    } finally {
      await one.stop();
    }
  });

  it("fans bus events out as delta events shaped per the SSE contract", async () => {
    const one = await startHubWeb({ ...deps, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${one.port}/stream`);
      const reader = res.body!.getReader();
      await reader.read(); // drain the initial snapshot chunk
      const sub = subscribers.at(-1)!;
      // publish deltas as the hub would (docs/04 §SSE contract shapes); the
      // phase payload rides on the status topic — topic→event naming is the
      // /stream endpoint's concern (tk-szb); this task pins transport + shape
      sub({ topic: "attention", payload: { op: "raised", item: { id: "att-9", sessionId: "tilt", kind: "question", text: "ping?", createdAt: new Date(0).toISOString() } } });
      sub({ topic: "log", payload: { sessionId: "tilt", hue: 42, entry: { t: 1, kind: "message", text: "hello" } } });
      sub({ topic: "summary", payload: { t: new Date(0).toISOString(), sessionId: "tilt", kind: "summary", text: "cycle done", by: "agent" } });
      sub({ topic: "status", payload: { sessionId: "tilt", phase: "working", at: new Date(0).toISOString() } });
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value!);
      expect(text).toContain("event: attention");
      expect(text).toContain("\"op\":\"raised\"");
      expect(text).toContain("event: log");
      expect(text).toContain("\"hue\":42");
      expect(text).toContain("event: summary");
      expect(text).toContain("event: status");
      expect(text).toContain("\"phase\":\"working\"");
      await reader.cancel();
    } finally {
      await one.stop();
    }
  });
});

describe("lifecycle", () => {
  it("subscribes to the bus on start", async () => {
    expect(subscribers.some((s) => s !== null)).toBe(true);
  });

  it("stop() unsubscribes, closes SSE, releases the port", async () => {
    const before = subscribers.filter((s) => s !== null).length;
    const one = await startHubWeb({ ...deps, port: 0 });
    expect(subscribers.filter((s) => s !== null).length).toBe(before + 1);
    const sse = await fetch(`http://127.0.0.1:${one.port}/stream`);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    void sse.body?.cancel();
    await one.stop();
    // unsubscribed; the shared server's subscription unaffected
    expect(subscribers.filter((s) => s !== null).length).toBe(before);
    // port released: a fresh bind on the same port must succeed
    const reborn = await startHubWeb({ ...deps, port: one.port });
    expect(reborn.port).toBe(one.port);
    await reborn.stop();
  });

  it("binds 127.0.0.1 — loopback fetch works, external hostname refused", async () => {
    const one = await startHubWeb({ ...deps, port: 0 });
    const res = await fetch(`http://127.0.0.1:${one.port}/api/status`);
    expect(res.ok).toBe(true);
    // Bun binds only the given hostname: 0.0.0.0 would answer on ::1 too
    const localhost6 = await fetch(`http://[::1]:${one.port}/api/status`).catch((e) => e);
    expect(localhost6).toBeInstanceOf(Error);
    await one.stop();
  });
});
