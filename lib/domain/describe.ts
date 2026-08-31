// lib/domain/describe.ts — stage 2 of the event normalize pipeline: pure
// classification of a batch of log entries into per-session phase + description
// (docs/06 §Hub agent loop step 2). The attention rubric lives in attention.ts
// (proposeAttention); this module routes through it instead of duplicating the
// patterns. Pure types + pure functions; zero imports.
import type { LogEntry, Phase } from "./session";
import { proposeAttention } from "./attention";

/** One per-session classification: phase + what it is doing now (≤12 words). */
export type SessionClassification = {
  sessionId: string;
  phase: Phase;
  /** ≤12 words; rendered verbatim on every surface's digest line */
  description: string;
};

/** Recorded state the classifier folds against (pure data; no ports). */
export type ClassifierSessionState = {
  /** phase currently recorded in status.json for the session */
  phase: Phase;
  /** last observed activity, epoch ms (session.lastActivity parsed) */
  lastActivityAt: number;
};

/** Idle conditions clear on the next event from the session (docs/06). */
const clearable: Phase[] = ["idle", "waiting", "blocked"];

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

const tail = (text: string, maxWords: number): string => {
  const w = words(text);
  return (w.length > maxWords ? w.slice(-maxWords) : w).join(" ");
};

const describeEvent = (entry: LogEntry): string => {
  switch (entry.kind) {
    case "user_message":
      return tail(`asked: ${entry.text}`, 12);
    case "tool_call":
      return entry.text.trim()
        ? tail(`running ${entry.text}`, 12)
        : "running a tool";
    case "assistant_message":
      return tail(entry.text, 12);
    default:
      return "working";
  }
};

/**
 * Classify one batch: fold entries in arrival order, last meaningful event
 * wins per session (docs/06: "Classification is one pass per event batch, not
 * per event"). Waiting/blocked set only when the batch's last attention-bearing
 * event for the session is that kind; user_message clears waiting/blocked/idle;
 * agent_end ends the turn (idle). Existing working phases stay working.
 */
export const classifyBatch = (
  batch: LogEntry[],
  states: Record<string, ClassifierSessionState> = {},
): Record<string, SessionClassification> => {
  const out: Record<string, SessionClassification> = {};

  for (const entry of batch) {
    const state = states[entry.sessionId];
    const s: SessionClassification = out[entry.sessionId] ?? {
      sessionId: entry.sessionId,
      phase: state?.phase ?? "working",
      description: describeEvent(entry),
    };

    if (entry.kind === "agent_end") {
      // Turn ended with nothing waiting on the user → awaiting next task.
      s.phase = "idle";
      s.description = "turn complete; awaiting next task";
    } else if (entry.kind === "user_message") {
      // A reply is the strongest signal: it clears waiting, blocked, and idle
      // (docs/06 resolution: "the watcher observes the user reply").
      s.phase = "working";
      s.description = describeEvent(entry);
    } else if (entry.kind === "tool_call" || entry.kind === "assistant_message") {
      const candidate = proposeAttention(entry, { now: state?.lastActivityAt ?? 0 });
      if (candidate?.kind === "approval" && (s.phase === "working" || clearable.includes(s.phase))) {
        s.phase = "waiting";
        s.description = tail(`awaiting approval: ${entry.text}`, 12);
      } else if (candidate?.kind === "question" && (s.phase === "working" || clearable.includes(s.phase))) {
        s.phase = "waiting";
        s.description = tail(`asked you: ${entry.text}`, 12);
      } else if (candidate?.kind === "blocked") {
        s.phase = "blocked";
        s.description = tail(`hit failure: ${entry.text}`, 12);
      } else {
        s.phase = "working";
        s.description = describeEvent(entry);
      }
    }
    // session_start: recorded in the roster by the reporter; the description
    // default ("working") is already right — nothing to refine.

    out[entry.sessionId] = s;
  }

  return out;
};

/**
 * Sessions idle past their timeout with nothing queued (docs/06 detection
 * rules, "session idle past its timeout"). Pure: sessions NOT present in the
 * batch whose lastActivityAt is older than idleTimeoutMs flip to idle. Batch
 * sessions never flip here — an event is activity. Only "working" sessions
 * flip: waiting and blocked sessions already have an open item (something is
 * queued — the user or the failure), and idle sessions are already idle.
 */
export const idleSessions = (
  batchSessionIds: ReadonlySet<string>,
  states: Record<string, ClassifierSessionState>,
  opts: { now: number; idleTimeoutMs: number },
): string[] =>
  Object.entries(states)
    .filter(([sessionId, s]) => {
      if (batchSessionIds.has(sessionId)) return false; // batch event = activity
      if (s.phase !== "working") return false; // open item or already idle
      return opts.now - s.lastActivityAt >= opts.idleTimeoutMs;
    })
    .map(([sessionId]) => sessionId);
