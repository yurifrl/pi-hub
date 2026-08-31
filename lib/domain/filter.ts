// lib/domain/filter.ts — id/phase/kind/text predicates shared by every read op
// (docs/01-architecture.md §Package layout; tail/list semantics in §Core abstractions).
// Pure types + pure functions; zero imports.

import type { AttentionItem, AttentionKind, LogEntry, Phase, SessionRecord, SummaryLine } from "./session";

export type Filter = {
  /** match a single session by id */
  id?: string;
  /** match sessions in any of the given phases */
  phase?: Phase[];
  /** match attention items or log entries of any of the given kinds */
  kind?: AttentionKind[];
  /** substring match, case-insensitive, across text (and session title) */
  text?: string;
};

const substring = (haystack: string | undefined, needle: string): boolean =>
  haystack !== undefined && haystack.toLowerCase().includes(needle.toLowerCase());

/** True when the summary line satisfies every set predicate. */
export const matchesSummary = (line: SummaryLine, f?: Filter): boolean => {
  if (!f) return true;
  if (f.id !== undefined && line.sessionId !== f.id) return false;
  if (f.text !== undefined && !substring(line.text, f.text)) return false;
  return true;
};

/** True when the attention item satisfies every set predicate. */
export const matchesAttention = (item: AttentionItem, f?: Filter): boolean => {
  if (!f) return true;
  if (f.id !== undefined && item.sessionId !== f.id) return false;
  if (f.kind !== undefined && f.kind.length > 0 && !f.kind.includes(item.kind)) return false;
  if (f.text !== undefined && !substring(item.text, f.text)) return false;
  return true;
};

/** True when the session record satisfies every set predicate. */
export const matchesSession = (session: SessionRecord, f?: Filter): boolean => {
  if (!f) return true;
  if (f.id !== undefined && session.agentSurface !== f.id && session.title !== f.id) {
    // `id` on sessions matches the session record's own identity surface:
    // title or declared surface; callers keying the sessions map already have
    // the record, so this predicate is for cross-store scans.
    if (!substring(session.title, f.id)) return false;
  }
  if (f.phase !== undefined && f.phase.length > 0 && !f.phase.includes(session.phase)) return false;
  if (f.text !== undefined && !substring(session.description, f.text) && !substring(session.title, f.text)) return false;
  return true;
};

/** True when the log entry satisfies every set predicate. */
export const matchesLogEntry = (entry: LogEntry, f?: Filter): boolean => {
  if (!f) return true;
  if (f.id !== undefined && entry.sessionId !== f.id) return false;
  if (f.kind !== undefined && f.kind.length > 0 && !f.kind.includes(entry.kind as AttentionKind)) return false;
  if (f.text !== undefined && !substring(entry.text, f.text)) return false;
  return true;
};
