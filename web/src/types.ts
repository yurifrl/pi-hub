// web/src/types.ts — dependency + payload contracts for @yurifrl/hub-web
// (docs/04-web.md §Server). Types only: the web package holds no file I/O of
// its own beyond reading log/surface files through injected ports.
//
// Import matrix (docs/01-architecture.md): web imports lib via the barrel,
// never @earendil-works/*, never cli.

import type {
  AttentionItem,
  AttentionStore,
  CommandSurface,
  EventBus,
  SessionRecord,
  StatusStore,
  SummaryLine,
  SummaryStore,
  ThemeToken,
} from "@yurifrl/hub";

/**
 * Per-session line of the snapshot payload. The snapshot is the single
 * full-state shape — `GET /api/status` returns exactly it, and the `snapshot`
 * SSE event carries the same JSON (docs/04-web.md §SSE contract).
 */
export interface SessionDigest {
  id: string;
  session: SessionRecord;
}

/** Full state a renderer paints from — one shape, two transports. */
export interface SnapshotPayload {
  /** status.json schema version */
  v: number;
  /** true when the hub agent is live (digest or agentSession present) — drives the agent-off fallback */
  agentOn: boolean;
  /** orientation line: hub-agent digest, or synthesized counts */
  digest: string;
  /** sessionId of the hub agent itself; undefined while the agent is off */
  agentSession?: string;
  /** open attention items */
  attention: AttentionItem[];
  /** open sessions */
  sessions: SessionDigest[];
}

/**
 * One log line as stored on disk (docs/02 ## logs event line shape: `t` a UTC
 * string, kind from the log vocabulary, `meta` free-form per-kind extras).
 * Produced by the host's log adapter reading `logs/<id>.jsonl` via the
 * status.json log LINK — the web package never reads the file itself
 * (docs/04 §Server: log is a link, never content).
 */
export type LogLine = {
  t: string;
  sessionId?: string;
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
};

/** One log line as the detail pages render it: `t` normalized to epoch ms so
 * the `?since=` cursor and the client's last-seen timestamp share one
 * numeric vocabulary. */
export type LogViewEntry = {
  t: number;
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
};

/**
 * Log tail port shape the web package needs; satisfied by injecting the lib
 * jsonl_store adapter via the status.json log LINK (tailLog unwrapped from
 * its Result). Not a new lib port. Returns a bounded, oldest-first tail
 * (docs/04 §Session detail: bounded tail + `?since=` cursor for live
 * tailing); `since` (a `t` from a previous read) narrows to entries strictly
 * newer than it. Async — the adapter reads the file per request.
 */
export type HubWebLogs = {
  tail(id: string, since?: string): Promise<LogLine[]>;
};

/** One entry of the archive index (docs/02 §archive: tombstone record). */
export type HubArchiveEntry = {
  id: string;
  closedAt: string;
  closedBy: string;
  finalSummary: string;
  /** archive-relative path, e.g. archive/2026-08/<id>.json */
  path: string;
};

/** One full archive record — SessionRecord as last seen plus the close tail. */
export type HubArchiveRecord = {
  id: string;
  record: SessionRecord;
  closedAt: string;
  closedBy: string;
  finalSummary: string;
  resolutions: AttentionItem[];
};

/**
 * Archive reader port (docs/04 §Routes /archive*: the web package holds no
 * file I/O of its own beyond reading log/surface files through injected
 * ports). `list` returns archive/YYYY-MM/*.json newest first, no socket
 * reads; `read` returns the full record or null when the id is not archived.
 * Async — the adapter reads files per request.
 */
export type HubWebArchive = {
  list(): Promise<HubArchiveEntry[]>;
  read(id: string): Promise<HubArchiveRecord | null>;
};

/** One section of an agent surface state file (docs/06 §agentSurface contract). */
export type SurfaceSection = {
  title: string;
  /** pre-wrapped, rendered verbatim */
  lines: string[];
  /** maps to theme tokens; default info */
  tone?: "info" | "warn" | "err";
};

/** ~/.hub/agents/<name>/surface.json — the agent-owned UI file (docs/06).
 * Unknown fields ignored on read (forward compat); renderers truncate
 * sections, never fail. */
export type SurfaceState = {
  agent: string;
  surface: string;
  revision: number;
  updatedAt: string;
  headline?: string;
  sections?: SurfaceSection[];
};

/** Surface state file port; the agent is the one writer, web only reads.
 * Async — the adapter reads the file per request. */
export type HubWebSurfaces = {
  read(agentName: string): Promise<SurfaceState | null>;
};

/** Theme token overrides; defaults to lib/theme.ts. */
export type HubWebTheme = Record<ThemeToken, string>;

/** One open SSE connection the server must be able to close on stop().
 * `push` is the delta write side — the server's bus subscription calls it with
 * payloads shaped per the docs/04 §SSE contract (event name + JSON payload). */
export type SseConn = {
  close(): void;
  /** enqueue one delta event; no-op after close or client disconnect */
  push?(event: string, data: unknown): void;
};

/** Latest summaries.jsonl lines for the summary rail (docs/04 §Main page 6). */
export type SummaryFeed = SummaryLine[];

/**
 * Session detail view-model: open flavor (live record) or archived flavor
 * (archive record + close tail, docs/02 §archive). `/session/:id` looks in
 * open sessions first, then the archive (docs/04 §Route rules); the same
 * renderer paints both, data-driven flavor.
 */
export type SessionDetail =
  | { flavor: "open"; id: string; record: SessionRecord; entries: LogViewEntry[] }
  | {
      flavor: "archived";
      id: string;
      record: SessionRecord;
      closedAt: string;
      closedBy: string;
      finalSummary: string;
      resolutions: AttentionItem[];
      entries: LogViewEntry[];
    };

/**
 * Agent page view-model (docs/04 §Agent page): the hub agent's live record
 * plus what the bundled `watcher` panel shows. Null → empty-state page.
 */
export type AgentPageInfo = {
  sessionId: string;
  record: SessionRecord;
  digest: string;
  /** open attention items by kind (all four, zero-padded by the renderer) */
  counts: Record<AttentionItem["kind"], number>;
  /** latest summary line for the agent session; null when none yet */
  lastSummary: SummaryLine | null;
};

/** Deps shape (docs/04-web.md §Server type sketch). */
export type HubWebDeps = {
  /** default 7749; binds 127.0.0.1 only, non-configurable bind in v1 */
  port?: number;
  stores: {
    status: StatusStore; // read status.json + sessions map
    summaries: SummaryStore; // tail summaries.jsonl
    attention: AttentionStore; // read attention items
  };
  /** hub event bus; web subscribes, never publishes state */
  bus: EventBus;
  /** answer / dismiss / assign / send — all writes go through here */
  commands: CommandSurface;
  logs?: HubWebLogs;
  /** archive index + record reader; absent → archive surfaces render empty */
  archive?: HubWebArchive;
  /** agent surface.json reader; absent → custom surfaces degrade to the generic card */
  surfaces?: HubWebSurfaces;
  /** the hub agent's registered name (~/.hub/agents/<name>/); default "hub-watcher" */
  agentName?: string;
  theme?: HubWebTheme;
};
