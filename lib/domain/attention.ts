// lib/domain/attention.ts — stage 2 of the event normalize pipeline: pure
// classification of log entries into attention candidates.
// Pure types + pure functions; zero imports (docs/01-architecture.md §Core abstractions).

import type { AttentionKind, AttentionItem, LogEntry } from "./session";

export type { AttentionKind, AttentionItem };

/** Why an entry needs a human — mirrors the hub agent detection rules (docs/06). */
export type { AttentionKind as Kind };

/**
 * Stage 2 output: a proposed attention item, not yet committed. The hub agent
 * commits via AttentionStore.raise (stage 3); id and timestamps are hub-minted.
 */
export type AttentionCandidate = {
  sessionId: string;
  kind: AttentionKind;
  text: string;
  /** why this needs a human */
  evidence: LogEntry[];
};

/** Context injected by the caller — pure data, no ports (Clock value is a number). */
export type AttentionContext = {
  /** Clock.now() at proposal time (docs/01: domain functions are deterministic given a Clock) */
  now: number;
  /** idle timeout in ms; idle candidates only fire past it (docs/06 detection rules) */
  idleTimeoutMs?: number;
  /** last known activity of the session (epoch ms); with now determines idleness */
  lastActivityAt?: number;
};

export type AttentionDetection =
  | { kind: "approval"; patterns: RegExp[] }
  | { kind: "question"; patterns: RegExp[] }
  | { kind: "blocked"; patterns: RegExp[] };

const APPROVAL_PATTERNS: RegExp[] = [
  /\bapprove\b/i,
  /\bapproval\b/i,
  /\bconfirm\b/i,
  /\bpermission request\b/i,
  /\ballow\b.*\?$/i,
  /\bgrant\b.*\baccess\b/i,
  /\byes\/no\b/i,
  /\bproceed\?\s*$/i,
];

const QUESTION_PATTERNS: RegExp[] = [
  /\?\s*$/,
  /\bwhich\b.*\?/i,
  /\bwhat\b.*\?/i,
  /\bshould (i|we)\b.*\?/i,
  /\bcould (you|i)\b.*\?/i,
  /\bdo you want\b/i,
  /\bhow would you like\b/i,
];

const BLOCKED_PATTERNS: RegExp[] = [
  /\bmissing (credential|token|secret|api[_ ]?key)\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bcannot (find|resolve|connect)\b/i,
  /\bfailed (dependency|to install|to build|to compile)\b/i,
  /\brepeated(ly)?\b[\w\s]*\bfail/i,
  /\bfail(ure|ed|ing)\b.{0,40}\b(retry|again|exhaust)/i,
  /\bfatal\b/i,
  /\bECONNREFUSED\b/,
  /\bENOENT\b/,
];

const matchKind = (text: string, patterns: RegExp[]): boolean => patterns.some((p) => p.test(text));

/**
 * Stage 2 — propose attention from one normalized log entry.
 * Pure: entry in, candidate out (or null). Priority order follows the docs/06
 * detection rules table: approval > question > blocked. Unsure? raise nothing.
 */
export function proposeAttention(entry: LogEntry, ctx: AttentionContext): AttentionCandidate | null {
  if (entry.kind === "session_start" || entry.kind === "agent_end") return null;

  const text = entry.text;
  if (!text) return null;

  if (matchKind(text, APPROVAL_PATTERNS)) {
    return {
      sessionId: entry.sessionId,
      kind: "approval",
      text: text,
      evidence: [entry],
    };
  }

  if (matchKind(text, QUESTION_PATTERNS)) {
    return {
      sessionId: entry.sessionId,
      kind: "question",
      text: text,
      evidence: [entry],
    };
  }

  if (matchKind(text, BLOCKED_PATTERNS)) {
    return {
      sessionId: entry.sessionId,
      kind: "blocked",
      text: text,
      evidence: [entry],
    };
  }

  // idle: past timeout with nothing queued (docs/06: "session idle past its
  // timeout with nothing queued (Clock port)"). Detectable only when the
  // caller supplies the timeout and the session's last activity.
  if (ctx.idleTimeoutMs !== undefined && ctx.lastActivityAt !== undefined) {
    if (ctx.now - ctx.lastActivityAt >= ctx.idleTimeoutMs) {
      return {
        sessionId: entry.sessionId,
        kind: "idle",
        text: text,
        evidence: [entry],
      };
    }
  }

  return null;
}
