// lib/domain/session.test.ts — pure unit: session domain shapes exercised as
// type-level fixtures and export presence (docs/01 §Testing: pure unit, no
// I/O, no mocks). Normative field lists: docs/02 §status.json.
import { describe, it, expect } from "bun:test";
import type {
  Phase,
  SessionKind,
  SessionStatus,
  SessionRecord,
  ArchivedLink,
  HubMeta,
  StatusFile,
  RawOmpEvent,
  LogEntry,
  HubEvent,
  StatusSnapshot,
  RenderBlock,
  SurfaceRenderer,
  RenderedSurface,
  AttentionKind,
  AttentionItem,
  SummaryLine,
} from "./session";

const T0 = "2026-08-30T17:57:51.401Z";

const record: SessionRecord = {
  status: "open",
  kind: "peer",
  cwd: "/Users/yuri/DotFiles",
  title: "review the tilt deploy plan",
  model: "aihub/glm-5.3-flash",
  description: "mid-review of deploy plan; paused on canary approval",
  phase: "waiting",
  phaseHistory: [
    { phase: "working", at: "2026-08-30T17:43:02.881Z" },
    { phase: "waiting", at: "2026-08-30T17:52:19.400Z" },
  ],
  log: "logs/s-9f2c.jsonl",
  toolCounts: { read: 14, edit: 3, bash: 7 },
  turns: 9,
  startedAt: "2026-08-30T17:42:58.201Z",
  lastActivity: "2026-08-30T17:52:19.400Z",
  agentSurface: "watcher",
};

describe("Phase / SessionKind / SessionStatus enums (docs/02)", () => {
  it("Phase accepts exactly working|waiting|idle|blocked", () => {
    const phases: Phase[] = ["working", "waiting", "idle", "blocked"];
    expect(phases).toHaveLength(4);
  });

  it("SessionKind accepts exactly peer|self|worker|agent", () => {
    const kinds: SessionKind[] = ["peer", "self", "worker", "agent"];
    expect(kinds).toHaveLength(4);
  });

  it("SessionStatus accepts exactly open|closing", () => {
    const statuses: SessionStatus[] = ["open", "closing"];
    expect(statuses).toHaveLength(2);
  });

  it("AttentionKind accepts exactly approval|question|blocked|idle", () => {
    const kinds: AttentionKind[] = ["approval", "question", "blocked", "idle"];
    expect(kinds).toHaveLength(4);
  });
});

describe("SessionRecord fixture mirrors the docs/02 example", () => {
  it("carries the full example record", () => {
    expect(record.status).toBe("open");
    expect(record.kind).toBe("peer");
    expect(record.phase).toBe("waiting");
    expect(record.log).toBe("logs/s-9f2c.jsonl");
    expect(record.toolCounts).toEqual({ read: 14, edit: 3, bash: 7 });
    expect(record.turns).toBe(9);
    expect(record.phaseHistory).toHaveLength(2);
    expect(record.agentSurface).toBe("watcher");
  });

  it("minimal record omits optionals and compiles", () => {
    const minimal: SessionRecord = {
      status: "open",
      kind: "worker",
      cwd: "/tmp",
      title: "worker atlas",
      model: "aihub/glm-5.3-flash",
      phase: "idle",
      log: "logs/s-4a71.jsonl",
      toolCounts: {},
      turns: 0,
      startedAt: T0,
      lastActivity: T0,
    };
    expect(minimal.description).toBeUndefined();
    expect(minimal.phaseHistory).toBeUndefined();
    expect(minimal.agentSurface).toBeUndefined();
  });
});

describe("StatusFile = meta + sessions + attention + archived (docs/02)", () => {
  it("assembles the full docs/02 example object", () => {
    const item: AttentionItem = {
      id: "att-6",
      sessionId: "s-9f2c",
      kind: "approval",
      text: "approve deploy canary 2/3 for tilt",
      createdAt: "2026-08-30T17:52:19.400Z",
    };
    const resolved: AttentionItem = {
      id: "att-3",
      sessionId: "s-c0de",
      kind: "question",
      text: "keep raw logs forever?",
      createdAt: "2026-08-30T15:40:12.300Z",
      resolvedAt: "2026-08-30T15:41:02.000Z",
      answer: "yes for v1",
    };
    const link: ArchivedLink = {
      id: "s-c0de",
      path: "archive/2026-08/s-c0de.json",
      closedAt: "2026-08-30T16:59:41.900Z",
    };
    const status: StatusFile = {
      version: 1,
      startedAt: "2026-08-30T17:42:10.113Z",
      pid: 43187,
      nextAttentionId: 8,
      digest: "tilt needs approval for deploy canary; atlas is idle",
      agentSession: "s-hub-01",
      sessions: { "s-9f2c": record },
      attention: [item, resolved],
      archived: [link],
    };
    expect(status.version).toBe(1);
    expect(status.pid).toBe(43187);
    expect(status.attention).toHaveLength(2);
    expect(resolved.answer).toBe("yes for v1");
    expect(link.path).toContain("archive/2026-08/");
  });
});

describe("RawOmpEvent covers the five reporter frames (docs/01 stage 1)", () => {
  it("each frame shape compiles", () => {
    const events: RawOmpEvent[] = [
      { type: "session_start", sessionId: "s-1", attached: false, cwd: "/tmp" },
      { type: "user_message", sessionId: "s-1", text: "go" },
      { type: "assistant_message", sessionId: "s-1", text: "done" },
      { type: "tool_call", sessionId: "s-1", tool: "bash", args: { command: "bun test" } },
      { type: "agent_end", sessionId: "s-1", exitSummary: "finished" },
    ];
    expect(events).toHaveLength(5);
    expect(events[3]!.type).toBe("tool_call");
    expect(events[4]!.type).toBe("agent_end");
  });
});

describe("LogEntry — one rendered line, no nested structures", () => {
  it("t is epoch ms (Clock.now() at normalize time), kind is a reporter frame", () => {
    const entry: LogEntry = { t: 1756572000000, sessionId: "s-1", kind: "tool_call", text: "bash: bun test" };
    expect(Number.isInteger(entry.t)).toBe(true);
    expect(entry.meta).toBeUndefined();
  });

  it("optional meta carries per-kind extras", () => {
    const entry: LogEntry = {
      t: 0,
      sessionId: "s-1",
      kind: "agent_end",
      text: "exit",
      meta: { event: "agent_end", reason: "exit" },
    };
    expect(entry.meta).toEqual({ event: "agent_end", reason: "exit" });
  });
});

describe("HubEvent topics (docs/01 stage 4)", () => {
  it("topic accepts exactly log|status|attention|summary", () => {
    const topics: HubEvent["topic"][] = ["log", "status", "attention", "summary"];
    const events: HubEvent[] = topics.map((topic) => ({ topic, payload: null }));
    expect(events).toHaveLength(4);
  });
});

describe("StatusSnapshot — the renderer paint input", () => {
  it("assembles sessions + attention + summaries + agent presence", () => {
    const line: SummaryLine = { t: T0, sessionId: "s-9f2c", kind: "summary", text: "mid-review", by: "agent" };
    const item: AttentionItem = {
      id: "att-6",
      sessionId: "s-9f2c",
      kind: "approval",
      text: "approve canary",
      createdAt: T0,
    };
    const snapshot: StatusSnapshot = {
      sessions: { "s-9f2c": record },
      attention: [item],
      summaries: [line],
      agent: { present: true, surfaceId: "watcher" },
    };
    expect(snapshot.agent.present).toBe(true);
    expect(snapshot.agent.surfaceId).toBe("watcher");
    expect(snapshot.attention[0]!.id).toBe("att-6");
  });

  it("agent off → present false, surfaceId null", () => {
    const snapshot: StatusSnapshot = { sessions: {}, attention: [], summaries: [], agent: { present: false, surfaceId: null } };
    expect(snapshot.agent).toEqual({ present: false, surfaceId: null });
  });
});

describe("RenderBlock kinds (docs/01 renderer contract)", () => {
  it("each block kind compiles", () => {
    const item: AttentionItem = { id: "att-1", sessionId: "s-1", kind: "blocked", text: "stuck", createdAt: T0 };
    const entry: LogEntry = { t: 0, sessionId: "s-1", kind: "user_message", text: "go" };
    const blocks: RenderBlock[] = [
      { kind: "orientation", text: "tilt needs approval" },
      { kind: "attention", items: [item] },
      { kind: "running", sessions: [record] },
      { kind: "idle", sessions: [] },
      { kind: "log", entries: [entry] },
      { kind: "custom", surfaceId: "pending", payload: { steps: [] } },
    ];
    expect(blocks).toHaveLength(6);
    expect(blocks[5]!.kind).toBe("custom");
  });
});

describe("SurfaceRenderer — pure snapshot → view model", () => {
  it("render returns RenderedSurface without side effects", () => {
    const renderer: SurfaceRenderer = {
      id: "watcher",
      render: (snapshot: StatusSnapshot): RenderedSurface => ({
        blocks: [{ kind: "orientation", text: `${Object.keys(snapshot.sessions).length} sessions` }],
      }),
    };
    const snapshot: StatusSnapshot = { sessions: {}, attention: [], summaries: [], agent: { present: false, surfaceId: null } };
    const out = renderer.render(snapshot);
    expect(out.blocks).toEqual([{ kind: "orientation", text: "0 sessions" }]);
    expect(renderer.render(snapshot).blocks).toEqual(out.blocks);
  });
});

describe("HubMeta — hub meta block (docs/02)", () => {
  it("compiles with and without optionals", () => {
    const full: HubMeta = {
      version: 1,
      startedAt: T0,
      pid: 43187,
      nextAttentionId: 8,
      digest: "all clear",
      agentSession: "s-hub-01",
    };
    const off: HubMeta = { version: 1, startedAt: T0, pid: 43187, nextAttentionId: 1 };
    expect(full.digest).toBe("all clear");
    expect(off.digest).toBeUndefined();
    expect(off.agentSession).toBeUndefined();
  });
});
