// web/src/sse.ts — SSE event derivation (docs/04-web.md §SSE contract): turn
// hub events into the /stream delta vocabulary with presentation computed
// server-side (session hue precomputed so the client never hashes). The bus
// adapter is transport; this module is the vocabulary. Pure: no I/O.

import { sessionHue, type AttentionItem, type HubEvent, type LogEntry, type SummaryLine } from "@yurifrl/hub";
import type { Phase } from "@yurifrl/hub";

/** A client-facing SSE delta event: name + JSON-ready payload. The
 * `snapshot` event is not derived here — the /stream route serves it fresh
 * from current state at every connect/reconnect (docs/04 §SSE contract). */
export type SseEvent = {
  event: "attention" | "log" | "summary" | "phase";
  payload: unknown;
};

const PHASES: readonly Phase[] = ["working", "waiting", "idle", "blocked"];

/**
 * HubEvent → zero or more /stream deltas (docs/04 §SSE contract table).
 * Malformed payloads are dropped, never patched with defaults — the snapshot
 * is authoritative, so a lost delta self-heals on the next one; a fabricated
 * one would lie. `status` events (snapshot material: agent restart, archive
 * sweep, version bump) produce no delta — clients get a full snapshot from
 * the route, which owns connect/reconnect state.
 */
export const sseEventsFor = (evt: HubEvent): SseEvent[] => {
  switch (evt.topic) {
    case "attention": {
      const item = evt.payload as AttentionItem;
      if (typeof item?.id !== "string" || typeof item?.sessionId !== "string") return [];
      return [{ event: "attention", payload: { op: item.resolvedAt === undefined ? "raised" : "resolved", item } }];
    }
    case "log": {
      const e = evt.payload as LogEntry;
      if (typeof e?.sessionId !== "string" || typeof e?.kind !== "string" || typeof e?.text !== "string" || typeof e?.t !== "number") {
        return [];
      }
      return [{ event: "log", payload: { sessionId: e.sessionId, hue: sessionHue(e.sessionId), entry: { t: e.t, kind: e.kind, text: e.text } } }];
    }
    case "summary": {
      const s = evt.payload as SummaryLine;
      if (typeof s?.sessionId !== "string" || typeof s?.kind !== "string" || typeof s?.text !== "string" || typeof s?.t !== "string" || typeof s?.by !== "string") {
        return [];
      }
      return [{ event: "summary", payload: { t: s.t, sessionId: s.sessionId, kind: s.kind, text: s.text, by: s.by } }];
    }
    case "phase": {
      const p = evt.payload as { sessionId?: string; phase?: Phase; at?: string };
      if (typeof p?.sessionId !== "string" || typeof p?.phase !== "string" || typeof p?.at !== "string" || !PHASES.includes(p.phase)) {
        return [];
      }
      return [{ event: "phase", payload: { sessionId: p.sessionId, phase: p.phase, at: p.at } }];
    }
    default:
      return [];
  }
};
