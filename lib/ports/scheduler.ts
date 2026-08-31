// lib/ports/scheduler.ts — Scheduler: injected timers; tests run them manually.
// Imports nothing (docs/01-architecture.md §Core abstractions ports). The
// watcher runtime needs setTimeout for event-batch debounce, idle checks, and
// restart backoff; injecting it keeps lib free of node/bun std (docs/01
// import matrix: ports import domain only, never std).

export type Scheduler = {
  /** run fn after ms; returns a cancel function (idempotent, safe to call twice) */
  setTimeout(fn: () => void, ms: number): () => void;
};
