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
  LogEntry,
  SessionRecord,
  StatusStore,
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
  /** orientation line: hub-agent digest, or synthesized counts */
  digest: string;
  /** open attention items */
  attention: AttentionItem[];
  /** open sessions */
  sessions: SessionDigest[];
}

/**
 * Log tail port shape the web package needs; satisfied by injecting the lib
 * jsonl_store adapter via the status.json log LINK. Not a new lib port.
 */
export type HubWebLogs = {
  tail(id: string, since?: number): LogEntry[];
};

/** Theme token overrides; defaults to lib/theme.ts. */
export type HubWebTheme = Record<ThemeToken, string>;

/** One open SSE connection the server must be able to close on stop(). */
export type SseConn = {
  close(): void;
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
  theme?: HubWebTheme;
};
