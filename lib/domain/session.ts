// lib/domain/session.ts — session records, snapshots, renderer plugin contract,
// and the event normalize pipeline's raw/log/event shapes.
// Pure types + pure functions; zero imports (docs/01-architecture.md §Package layout).

/** Current digest phase of a session (docs/02-data-contracts.md §sessions map). */
export type Phase = "working" | "waiting" | "idle" | "blocked";

/** Session role: attached peer, the hub-hosting session, a spawned worker, or the hub agent. */
export type SessionKind = "peer" | "self" | "worker" | "agent";

export type SessionStatus = "open" | "closing";

export type PhaseTransition = { phase: Phase; at: string };

/**
 * One live session in status.json. Field contract owned by
 * docs/02-data-contracts.md §sessions map — this is the normative shape.
 */
export interface SessionRecord {
  status: SessionStatus;
  kind: SessionKind;
  /** working directory reported at session_start */
  cwd: string;
  /** first user message, truncated to 80 chars */
  title: string;
  /** model id reported at session_start */
  model: string;
  /** agent-written one-liner: what the session is doing now */
  description?: string;
  phase: Phase;
  /** appended on every phase transition, capped at 50 entries (oldest dropped) */
  phaseHistory?: PhaseTransition[];
  /** "logs/<id>.jsonl" — a link, never content */
  log: string;
  /** tool name → call count; starts {} */
  toolCounts: Record<string, number>;
  /** user turns observed; starts 0 */
  turns: number;
  startedAt: string;
  lastActivity: string;
  /** declared surface id (docs/06); surfaces default to "watcher" */
  agentSurface?: string;
}

/** Tombstone index entry in status.json `archived[]`. */
export type ArchivedLink = {
  id: string;
  path: string;
  closedAt: string;
};

/** Hub meta block — the first fields of status.json (docs/02 §Hub meta block). */
export type HubMeta = {
  /** schema version, currently 1; first field so readers can reject early */
  version: number;
  startedAt: string;
  /** writer pid; readers may use it to detect a dead hub */
  pid: number;
  /** counter for the next att-<n> id */
  nextAttentionId: number;
  /** hub-agent orientation one-liner; absent when the agent is off */
  digest?: string;
  /** sessionId of the hub agent itself; present while the agent runs */
  agentSession?: string;
};

/** The whole status.json object — every live fact. */
export interface StatusFile {
  version: number;
  startedAt: string;
  pid: number;
  nextAttentionId: number;
  digest?: string;
  agentSession?: string;
  sessions: Record<string, SessionRecord>;
  attention: AttentionItem[];
  archived: ArchivedLink[];
}

/** Raw omp event at the adapter edge (reporter → jsonl_store). */
export type RawOmpEvent =
  | {
      type: "session_start";
      sessionId: string;
      attached: boolean;
      cwd: string;
      /** session title (docs/05 §Reporter: session_start carries title); absent → keep existing */
      title?: string;
      /** model id reported at session_start (docs/02 §Reporter frames); absent → keep existing */
      model?: string;
    }
  | { type: "user_message"; sessionId: string; text: string }
  | { type: "assistant_message"; sessionId: string; text: string }
  | { type: "tool_call"; sessionId: string; tool: string; args: unknown }
  | { type: "agent_end"; sessionId: string; exitSummary?: string };

/** One rendered log line — no nested structures; `t` stamped at normalize time. */
export type LogEntry = {
  t: number;
  sessionId: string;
  kind: RawOmpEvent["type"];
  text: string;
  meta?: Record<string, unknown>;
};

/** HubEvent topics fanned out on the EventBus after every committed store change.
 * Mirrors the hub.sock event-frame kinds (docs/02 §Event frames): the five
 * reporter frame names plus attention and phase; `status` carries snapshot
 * material (agent restart, archive sweep) that is not expressible as a delta.
 */
export type HubEventTopic = "log" | "status" | "attention" | "summary" | "phase";

export type HubEvent = { topic: HubEventTopic; payload: unknown };

/** The full state a renderer paints from — store contract, not raw logs. */
export type StatusSnapshot = {
  sessions: Record<string, SessionRecord>;
  attention: AttentionItem[];
  /** tail, already filtered */
  summaries: SummaryLine[];
  agent: { present: boolean; surfaceId: string | null };
};

/** A pure snapshot → view-model result; the host's paint layer applies the medium. */
export type RenderedSurface = {
  blocks: RenderBlock[];
};

export type RenderBlock =
  | { kind: "orientation"; text: string }
  | { kind: "attention"; items: AttentionItem[] }
  | { kind: "running"; sessions: SessionRecord[] }
  | { kind: "idle"; sessions: SessionRecord[] }
  | { kind: "log"; entries: LogEntry[] }
  /** agent-declared surfaces */
  | { kind: "custom"; surfaceId: string; payload: unknown };

/** Renderer plugin contract; hosts paint, domain decides. */
export type SurfaceRenderer = {
  /** matches agentSurface id in ~/.hub/agents/<name>/surface.json */
  id: string;
  /** pure: snapshot in, view model out */
  render(snapshot: StatusSnapshot): RenderedSurface;
};

// ---- Attention shapes (owned here for the snapshot contract; semantics in attention.ts) ----

export type AttentionKind = "approval" | "question" | "blocked" | "idle";

/** Committed attention item as stored in status.json `attention[]` (open items only). */
export interface AttentionItem {
  id: string;
  sessionId: string;
  kind: AttentionKind;
  text: string;
  createdAt: string;
  /** set exactly once, if ever */
  resolvedAt?: string;
  /** set exactly once, alongside resolvedAt */
  answer?: string;
}

// ---- Summary shapes ----

export type SummaryKind = "summary" | "resolution";

/** One summaries.jsonl line — the AI digest rail (docs/02 §summaries.jsonl). */
export type SummaryLine = {
  t: string;
  sessionId: string;
  kind: SummaryKind;
  text: string;
  /** author: agent for summaries; the resolver for resolutions */
  by: string;
};
