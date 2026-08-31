// lib/domain/attention.ts — stage 2 of the event normalize pipeline: pure
// detection rules for attention candidates from normalized log entries (docs/06
// §Hub agent detection rules table — event in, kind and text out).
// Pure types + pure functions; zero imports (docs/01-architecture.md §Core abstractions).

import type { AttentionKind, AttentionItem, LogEntry } from "./session";

export type { AttentionKind, AttentionItem };

/** Cap for human-readable item text (docs/06: question text ≤ 160 chars). */
const TEXT_LIMIT = 160;

/** First line of a multi-line payload, trimmed — error summaries lead with it. */
const firstLine = (text: string): string => (text.split(/\r?\n/, 1)[0] ?? "").trim();

/**
 * Stable shortening for display text: trim, collapse to the first line, hard
 * cap at 160 chars with an ellipsis. Deterministic, locale-free.
 */
const clip = (text: string, limit = TEXT_LIMIT): string => {
  const line = firstLine(text);
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/**
 * FNV-1a over the UTF-8 byte view — a stable 32-bit hex digest without
 * node/bun std (domain imports nothing, docs/01). Same text → same digest in
 * every process and every run, which is what makes question causes stable.
 */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * Stable cause key for a raised item — one open item per (session, cause);
 * a re-raise updates the text, never duplicates (docs/06 raise rules; the
 * store enforces the invariant per docs/02, keyed (sessionId, kind) with the
 * cause as the finer identity). Key shapes:
 *   approval:<tool> | question:<sessionId>:<hash(text)>
 *   blocked:<tool>  | idle:<sessionId>
 * LogEntry carries no tool-call id (docs/02 log meta has `{ tool, args }`
 * only), so the tool name is the stable per-episode discriminator.
 */
const approvalCause = (tool: string): string => `approval:${tool}`;
const questionCause = (sessionId: string, text: string): string => `question:${sessionId}:${fnv1a(text)}`;
const blockedCause = (tool: string): string => `blocked:${tool}`;
const idleCause = (sessionId: string): string => `idle:${sessionId}`;

/** Approval-shape extras (permission-prompt metadata when the reporter carries it). */
export type ApprovalMeta = { toolName?: string; request?: string };

/** Blocked-shape extras. */
export type BlockedMeta = { toolName?: string; error?: string };

/** Detection results — one per docs/06 detection-table row that fires. */
export type AttentionDetection =
  | { kind: "approval"; cause: string; meta?: ApprovalMeta }
  | { kind: "question"; cause: string }
  | { kind: "blocked"; cause: string; meta?: BlockedMeta };

export type ApprovalDetection = Extract<AttentionDetection, { kind: "approval" }>;
export type QuestionDetection = Extract<AttentionDetection, { kind: "question" }>;
export type BlockedDetection = Extract<AttentionDetection, { kind: "blocked" }>;

/** Stage 2 output: a proposed attention item, not yet committed. The hub agent
 * commits via AttentionStore.raise (stage 3); id and timestamps are hub-minted.
 * `cause` is the stable cause key — always set by proposeAttention; optional in
 * the type because hand-built candidates (watcher catch-up) predate it. */
export type AttentionCandidate = {
  sessionId: string;
  kind: AttentionKind;
  text: string;
  /** why this needs a human */
  evidence: LogEntry[];
  /** stable identity of the cause — re-raises of the same cause must carry the same key */
  cause?: string;
};

/** Context injected by the caller — pure data, no ports (Clock value is a number). */
export type AttentionContext = {
  /** Clock.now() at proposal time (docs/01: domain functions are deterministic given a Clock) */
  now: number;
  /** idle timeout in ms; the idle branch fires only past it (docs/06 detection rules) */
  idleTimeoutMs?: number;
  /** last known activity of the session (epoch ms); with now determines idleness */
  lastActivityAt?: number;
};

// ---- detection rules (docs/06 §Hub agent detection rules table) -------------

// Approval shape 1 — permission-prompt prefixes on the rendered tool line
// ("approval request:", "permission request:", "confirmation:", "confirm:").
const APPROVAL_PREFIX = /^\s*(?:approval|permission|confirmation)(?:\s+request)?\s*[:：]/i;
const CONFIRM_PREFIX = /^\s*confirm(?:ation)?\s*[:：]/i;

// Approval shape 2 — a suggestion ending in a question mark, grounded so that
// word endings do not false-positive ("approved?" is a status, not a prompt;
// "approved, continue?" never matches the bare-token rule below).
const APPROVAL_SUGGESTION =
  /(?:^|[\s([{"'（「])(?:approve|allow|confirm|deny|reject)\?(?=$|[\s)\]}'"（）「」.,;:!?])/i;

// Approval shape 3 — an explicit yes/no choice offered to the user.
const APPROVAL_CHOICE = /(?:^|[\s([{"'（「])(?:yes\s*\/\s*no|y\s*\/\s*n)(?:\?|？)?(?=$|[\s)\]}'"（）「」.,;:!?])/i;

// Approval shape 4 — a tool_call whose rendered line opens with an approval
// verb (optionally polite): the strongest available permission-prompt signal
// on tool lines, gated to tool_call so narration never matches it.
const APPROVAL_IMPERATIVE = /^\s*(?:please\s+)?(?:approve|allow|confirm|deny|reject|grant)\b/i;

// Question shape — assistant output ending in a question mark (ASCII or CJK
// fullwidth), the i18n-light explicit "question:" marker, and the CJK final
// particle 吗 ("is it so?" with no question mark required).
const QUESTION_TERMINAL = /[?？]\s*$/;
const QUESTION_MARKER_PREFIX = /^\s*question\s*[:：]/i;
const QUESTION_CJK_PARTICLE = /吗\s*[?？]?\s*$/;

// Blocked shapes — a failing tool result the session cannot recover from
// alone (docs/06): error prefixes, hard error states, danger keywords on
// tool output, and the persisted-failure signature (retrying … failed).
const BLOCKED_PREFIX = /^\s*(?:error|failed|failure|fatal)\s*[:：]/i;
const BLOCKED_RISK = /\b(?:error|fatal|exception|panic)\b/i;
const BLOCKED_STATES = new RegExp(
  [
    "\\bunauthorized\\b",
    "\\bforbidden\\b",
    "\\bnot\\s+found\\b",
    "\\bpermission\\s+denied\\b",
    "\\benoent\\b",
    "\\beconn(?:refused|reset|aborted)?\\b",
    "\\betimedout\\b",
    "\\bmissing\\s+(?:credential|token|secret|api[_-]?key)\\b",
    "\\bcannot\\s+(?:find|resolve|connect)\\b",
    "\\bfailed\\s+to\\s+(?:install|build|compile)\\b",
    "\\bdependency\\s+(?:conflict|resolution\\s+failed)\\b",
    "\\bout\\s+of\\s+(?:memory|disk\\s+space)\\b",
  ].join("|"),
  "i",
);
const BLOCKED_PERSISTENT = /\b(?:retried|retrying|retry)\b[^.?!]*\bfailed\b|\bfailed\b[^.?!]*\b(?:retried|retrying|retry)\b/i;

// Blocked shape — repetition as the failure signature: "repeated tool
// failure", "repeatedly failed", retries exhausted (docs/06: a failure the
// session cannot recover from alone — it already retried).
const BLOCKED_REPEATED = /\brepeated(?:ly)?\b(?:\s+\w+){0,3}?\s*\bfail/i;
const BLOCKED_EXHAUSTED = /\bretries?\s+exhausted\b/i;

/** Extract the tool name from meta (`{ tool, args }` per docs/02 log meta) or
 * a leading "toolName:" line prefix — never from message text. */
const toolNameOf = (entry: LogEntry): string | undefined => {
  const meta = entry.meta as { tool?: unknown } | undefined;
  if (meta && typeof meta.tool === "string" && meta.tool.trim()) return meta.tool.trim();
  const m = entry.text.match(/^\s*([A-Za-z][\w-]*)\s*[:：]/);
  return m ? m[1]!.toLowerCase() : undefined;
};

/** Rule 1 — tool result waiting on the user (approval prompt, permission
 * request, confirm) → kind approval. */
export const detectApproval = (entry: LogEntry): ApprovalDetection | null => {
  const text = entry.text.trim();
  if (!text) return null;

  const prefix = APPROVAL_PREFIX.test(text) || CONFIRM_PREFIX.test(text);
  const suggestion = APPROVAL_SUGGESTION.test(text);
  const choice = APPROVAL_CHOICE.test(text);
  const imperative = entry.kind === "tool_call" && APPROVAL_IMPERATIVE.test(text);
  if (!prefix && !suggestion && !choice && !imperative) return null;

  const toolName = toolNameOf(entry);
  return {
    kind: "approval",
    cause: approvalCause(toolName ?? "tool"),
    ...(toolName !== undefined || prefix || choice
      ? { meta: { ...(toolName !== undefined ? { toolName } : {}), ...(prefix || choice ? { request: clip(text) } : {}) } }
      : {}),
  };
};

/** Rule 2 — assistant output shaped as a question to the user → kind question. */
export const detectQuestion = (entry: LogEntry): QuestionDetection | null => {
  const text = entry.text.trim();
  if (!text) return null;

  const shaped = QUESTION_TERMINAL.test(text) || QUESTION_MARKER_PREFIX.test(text) || QUESTION_CJK_PARTICLE.test(text);
  if (!shaped) return null;

  // Stable identity: the question text as asked (trimmed, first line) — the
  // same question re-raised hashes equal, so the store updates in place.
  return { kind: "question", cause: questionCause(entry.sessionId, firstLine(text)) };
};

/** Rule 3 — tool failure the session cannot recover from alone → kind blocked. */
export const detectBlocked = (entry: LogEntry): BlockedDetection | null => {
  const text = entry.text.trim();
  if (!text) return null;

  const failing =
    BLOCKED_PREFIX.test(text) ||
    BLOCKED_STATES.test(text) ||
    BLOCKED_PERSISTENT.test(text) ||
    BLOCKED_REPEATED.test(text) ||
    BLOCKED_EXHAUSTED.test(text);
  const risky = entry.kind === "tool_call" && BLOCKED_RISK.test(text);
  if (!failing && !risky) return null;

  const toolName = toolNameOf(entry);
  return {
    kind: "blocked",
    cause: blockedCause(toolName ?? "tool"),
    meta: { ...(toolName !== undefined ? { toolName } : {}), error: firstLine(text) },
  };
};

/**
 * Stage 2 — propose attention from one normalized log entry.
 * Pure: entry in, candidate out (or null). Priority order follows the docs/06
 * detection rules table: approval > question > blocked > idle. Unsure? raise
 * nothing (docs/06: "a false alarm is worse than a late item").
 *
 * Idle branch: "session idle past its timeout with nothing queued (Clock
 * port)". The session-level rule — phase-gated, once per idle episode — lives
 * in `idleSessions` (lib/domain/describe.ts), which the watcher's idle pass
 * uses; this entry-level branch is the per-entry fallback that fires only
 * when the caller supplies both the idle timeout and the session's last
 * activity. Both share the same threshold semantics: now - lastActivity >=
 * idleTimeoutMs.
 */
export function proposeAttention(entry: LogEntry, ctx: AttentionContext): AttentionCandidate | null {
  if (entry.kind === "session_start" || entry.kind === "agent_end") return null;

  const approval = detectApproval(entry);
  if (approval) {
    // text = tool + short why (docs/06): the request line is the why.
    const request = firstLine(entry.text);
    const tool = approval.meta?.toolName;
    return {
      sessionId: entry.sessionId,
      kind: approval.kind,
      text: clip(tool ? `${tool} needs approval: ${request}` : `needs approval: ${request}`),
      evidence: [entry],
      cause: approval.cause,
    };
  }

  const question = detectQuestion(entry);
  if (question) {
    return {
      sessionId: entry.sessionId,
      kind: question.kind,
      text: clip(entry.text),
      evidence: [entry],
      cause: question.cause,
    };
  }

  const blocked = detectBlocked(entry);
  if (blocked) {
    const tool = blocked.meta?.toolName;
    const error = blocked.meta?.error ?? "";
    return {
      sessionId: entry.sessionId,
      kind: blocked.kind,
      text: clip(tool ? `${tool}: ${error}` : error),
      evidence: [entry],
      cause: blocked.cause,
    };
  }

  // idle: past timeout with nothing queued. The text carries the idle
  // duration and the last activity as the summary (docs/06: "idle <N>m").
  if (ctx.idleTimeoutMs !== undefined && ctx.lastActivityAt !== undefined) {
    const idleMs = ctx.now - ctx.lastActivityAt;
    if (idleMs >= ctx.idleTimeoutMs) {
      const minutes = Math.max(1, Math.round(idleMs / 60_000));
      return {
        sessionId: entry.sessionId,
        kind: "idle",
        text: clip(`idle ${minutes}m · ${firstLine(entry.text) || "no recent activity"}`),
        evidence: [entry],
        cause: idleCause(entry.sessionId),
      };
    }
  }

  return null;
}
