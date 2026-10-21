// lib/domain/omp_sessions.ts — machine-wide omp session inventory (docs/02 §sessions).
// Pure domain logic over caller-provided directory facts: no fs, no env, no hub
// state. lib/adapters/omp_transcripts.ts walks the omp transcript tree and feeds
// the facts in; hub_core merges the result with the hub roster (its sessions map
// wins — the reporter is authoritative for sessions that report themselves).

import type { SessionRecord } from "./session";

/** Machine-local freshness window: a transcript untouched for this long is
 * exited (the hub believes only live sessions; finished sessions leave the
 * board). Matches cmd_tails's END_QUIET_MS (docs/03 §tails). */
export const OMP_SESSION_STALE_MS = 40_000;

/** One machine-wide fact: a transcript-observed omp session. */
export type OmpSessionFact = {
  /** transcript filename UUID ("…_<uuid>.jsonl"); the name without the suffix
   * is the fallback so unparseable filenames still surface something stable */
  sessionId: string;
  /** flattened session dir decoded to the real cwd ("-Users-yuri-x" → /Users/yuri/x) */
  cwd: string;
  /** first user message, truncated to 80 chars — the SessionRecord.title rule */
  title: string;
  /** model id from the transcript's model_change lines; "" when unknown */
  model: string;
  /** transcript mtime, epoch ms — the freshness input */
  lastActivityMs: number;
  /** true = a farewell line was seen (session_end, or goodbye text) */
  saidBye: boolean;
};

/** The sessions op reply body (docs/02 §ops): roster rows plus machine-wide-only
 * facts, so every consumer reads one shape. Facts the roster does not know
 * appear as session rows with status "detached"; stale ones are counted in
 * `detached` (ids only) instead of shown. */
export type OmpSessionsResult = {
  sessions: Array<Record<string, unknown>>;
  /** fresh per staleness but no roster entry AND no recent activity */
  detached: string[];
  /** per-transcript read problems; the op still succeeds */
  errors: string[];
};

// ---- transcript line parsing -------------------------------------------------

export type TranscriptLine = {
  type?: string;
  customType?: string;
  /** "title" lines carry the session title; "session" lines repeat it */
  title?: string;
  data?: Record<string, unknown>;
  /** model_change lines carry the model id */
  model?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
  };
};

export const textOf = (message: TranscriptLine["message"]): string =>
  (message?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");

export const clip = (s: string, n = 160): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** sessionId = trailing UUID of the transcript filename "…_<uuid>.jsonl". */
export const idFromName = (name: string): string => {
  const m = /_([0-9a-f-]{36})\.jsonl$/.exec(name);
  return m ? m[1]! : name.replace(/\.jsonl$/, "");
};

/** cwd from the session directory name: omp flattens paths with "-" and
 * strips the leading slash ("-Users-yuri-.omp-wt-…" → /Users/yuri/.omp/wt/…). */
export const cwdFromDir = (dir: string): string => dir.replace(/^-/, "/").replace(/-/g, "/");

/** The transcript's own declared title: the newest "title"/"session" line's
 * `title` field (auto-titles update in place), trimmed; "" when absent. */
export const declaredTitle = (lines: TranscriptLine[]): string => {
  let title = "";
  for (const line of lines) {
    if ((line.type === "title" || line.type === "session") && typeof line.title === "string" && line.title.trim() !== "") {
      title = line.title.trim();
    }
  }
  return title;
};

/** The first user message as title material (SessionRecord.title semantics). */
export const firstUserText = (lines: TranscriptLine[]): string => {
  for (const line of lines) {
    if (line.type === "message" && line.message?.role === "user") {
      return textOf(line.message);
    }
  }
  return "";
};

/** Model id from model_change lines (the last one wins). */
export const modelFromLines = (lines: TranscriptLine[]): string => {
  let model = "";
  for (const line of lines) {
    if (line.type === "model_change" && typeof line.model === "string") model = line.model;
  }
  return model;
};

/** True when a scanned line is a farewell: the session_end event kind, or an
 * assistant message whose text matches the goodbye pattern. */
export const hasFarewell = (lines: TranscriptLine[]): boolean =>
  lines.some(
    (l) =>
      l.type === "session_end" ||
      (l.type === "message" && l.message?.role === "assistant" && /goodbye/i.test(textOf(l.message))),
  );

export const parseLine = (raw: string): TranscriptLine | null => {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj as TranscriptLine;
  } catch {
    return null;
  }
};

// ---- the machine-wide scan ----------------------------------------------------

export type TranscriptFile = {
  /** session dir name under the sessions root, e.g. "-Users-yuri-proj" */
  dir: string;
  /** transcript file name, e.g. "2026-…_<uuid>.jsonl" */
  name: string;
  /** stat metadata the adapter already gathered */
  mtimeMs: number;
};

/** The raw material the adapter feeds: per-file head bytes + tail bytes. */
export type TranscriptBlob = {
  file: TranscriptFile;
  /** first N bytes of the file (session/title/model lines live here) */
  head: string;
  /** last N bytes of the file (farewell lines live here) */
  tail: string;
};

/** One blob → OmpSessionFact. Head gives title/model/cwd, tail the farewell
 * marker; mtime is the freshness input. */
export const factFromHead = (blob: TranscriptBlob): OmpSessionFact => {
  const headLines = blob.head
    .split("\n")
    .map(parseLine)
    .filter((l): l is TranscriptLine => l !== null);
  const tailLines = blob.tail
    .split("\n")
    .map(parseLine)
    .filter((l): l is TranscriptLine => l !== null);
  return {
    sessionId: idFromName(blob.file.name),
    cwd: cwdFromDir(blob.file.dir),
    // Title precedence (docs/02 §sessions): the transcript's declared title
    // ("title"/"session" lines), else the first user message — the filename
    // fallback is last so an untitled session still shows something stable.
    title: clip(declaredTitle(headLines) || firstUserText(headLines) || blob.file.name.replace(/\.jsonl$/, ""), 80),
    model: modelFromLines([...headLines, ...tailLines]),
    lastActivityMs: blob.file.mtimeMs,
    saidBye: hasFarewell([...headLines, ...tailLines]),
  };
};

/** The roster-first merge behind the sessions op reply. Roster rows keep their
 * hub-record shape; facts the roster does not know become session rows with
 * status "detached" when fresh, or land in `detached` (ids) when stale
 * (nowMs - mtime > OMP_SESSION_STALE_MS). */
export const mergeFacts = (
  roster: Record<string, SessionRecord>,
  facts: OmpSessionFact[],
  nowMs: number,
): { sessions: Array<Record<string, unknown>>; detached: string[] } => {
  const sessions: Array<Record<string, unknown>> = [];
  const detached: string[] = [];
  for (const f of facts) {
    const rosterRow = roster[f.sessionId];
    if (rosterRow) {
      // fresh literal: interfaces lack implicit index signatures, spread widens;
      // the roster map is keyed by id — reply rows carry it (fact rows do too)
      sessions.push({ ...rosterRow, id: f.sessionId });
      continue;
    }
    if (nowMs - f.lastActivityMs > OMP_SESSION_STALE_MS) {
      detached.push(f.sessionId);
      continue;
    }
    sessions.push({
      id: f.sessionId,
      status: "detached",
      kind: "peer",
      cwd: f.cwd,
      title: f.title,
      model: f.model,
      phase: "working",
      startedAt: new Date(f.lastActivityMs).toISOString(),
      lastActivity: new Date(f.lastActivityMs).toISOString(),
    });
  }
  return { sessions, detached };
};
