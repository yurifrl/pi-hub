// lib/adapters/jsonl_store.ts — SummaryStore over <dataRoot>/summaries.jsonl plus
// append/tail/replay for per-session logs/<id>.jsonl.
// Port implementation; all I/O; imports ports + domain (docs/01-architecture.md §Package layout).
// File shapes owned by docs/02-data-contracts.md (## logs, ## summaries.jsonl):
// append-only, one JSON object per line, durability = a single write(2) at O_APPEND
// per line; on read a trailing line without a newline is discarded (torn tail);
// files are never rewritten or compacted — the only mutation is append.
// Log lines use the docs/02 ## logs event vocabulary (prompt|tool|result|think|
// message|system) with `t` as a UTC string — the on-disk contract. Domain
// LogEntry (t = epoch ms, omp frame kinds) is the normalize-pipeline shape that
// the reporter translates into these lines before appending.

import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { hubError } from "../domain/command";
import type { HubError, Result } from "../domain/command";
import type { SummaryLine } from "../domain/session";
import { matchesSummary } from "../domain/filter";
import type { SummaryStore } from "../ports/summary_store";

const SUMMARIES_FILE = "summaries.jsonl";
const LOGS_DIR = "logs";
/** Max chars of `text` kept per log line (docs/02 ## logs: "tool args/results
 * are summarized, truncated to 2 KB per line"). */
const LOG_TEXT_MAX = 2048;

const summariesPath = (dataRoot: string): string => path.join(dataRoot, SUMMARIES_FILE);
const logPath = (dataRoot: string, sessionId: string): string =>
  path.join(dataRoot, LOGS_DIR, `${sessionId}.jsonl`);

const fileError = (message: string, cause?: unknown): HubError =>
  hubError("unavailable-hub", message, { retryable: false, cause });

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Log event kinds — the docs/02 ## logs vocabulary, distinct from the omp
 * frame names carried by domain LogEntry. */
export type LogEventKind = "prompt" | "tool" | "result" | "think" | "message" | "system";

/** One rendered log line as stored on disk (docs/02 ## logs event line shape):
 * `t` a UTC string, kind from the log vocabulary, `meta` free-form per-kind
 * extras (session_start carries the attached flag + session kind). Unknown
 * fields tolerated on read (docs/02 §Versioning). */
export type StoredLogEntry = {
  t: string;
  sessionId: string;
  kind: LogEventKind;
  text: string;
  meta?: Record<string, unknown>;
};

/** Writer-side filter for log entries. Deliberately local: domain `Filter.kind`
 * carries the AttentionKind vocabulary, disjoint from LogEventKind — filtering
 * log lines through it would be always-false. Log reads narrow on the entry's
 * own kinds instead. */
export type LogFilter = {
  /** match entries of any of these log kinds */
  kind?: LogEventKind[];
  /** substring match, case-insensitive, across text */
  text?: string;
};

/** Writer-side helper (docs/01 §Testing pins it): clamp `text` to `max` chars
 * so no log line exceeds the 2 KB per-line cap. The reader tolerates longer
 * lines — truncation is a writer duty. */
export const truncateLogText = (text: string, max = LOG_TEXT_MAX): string =>
  text.length <= max ? text : text.slice(0, max);

/** Rebuild the entry with the canonical key order (t first) and the 2 KB clamp
 * applied, so the disk contract holds regardless of caller key order. */
const toStored = (entry: StoredLogEntry): StoredLogEntry => {
  const stored: StoredLogEntry = {
    t: entry.t,
    sessionId: entry.sessionId,
    kind: entry.kind,
    text: truncateLogText(entry.text),
  };
  if (entry.meta !== undefined) stored.meta = entry.meta;
  return stored;
};

const matchesLogFilter = (entry: StoredLogEntry, f?: LogFilter): boolean => {
  if (!f) return true;
  if (f.kind !== undefined && f.kind.length > 0 && !f.kind.includes(entry.kind)) return false;
  if (f.text !== undefined && !entry.text.toLowerCase().includes(f.text.toLowerCase())) return false;
  return true;
};

/** Append one line to an append-only file with a single write(2) at O_APPEND.
 * Creates the file (and its parent directory) on first append. The whole
 * serialized line is handed to one write call — a crash may lose the tail of
 * the last line but never corrupts earlier ones. */
const appendLine = async (filePath: string, line: unknown): Promise<Result<void, HubError>> => {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, "a");
    try {
      await handle.writeFile(JSON.stringify(line) + "\n", "utf8");
    } finally {
      await handle.close();
    }
    return ok(undefined);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: fileError(`append failed for ${path.basename(filePath)}: ${code ?? "error"}`, e) };
  }
};

/** Parse NDJSON content: discard a trailing line without a newline (torn tail
 * from a crash mid-append) and skip blank or invalid middle lines — a torn
 * line never fails the whole read. Unknown keys ride along untouched. */
const parseLines = (raw: string): unknown[] => {
  const cut = raw.endsWith("\n") ? raw.length - 1 : raw.lastIndexOf("\n") + 1;
  const complete = raw.slice(0, cut);
  const out: unknown[] = [];
  if (complete.length === 0) return out;
  for (const line of complete.split("\n")) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      // invalid middle line: skipped, the read never fails
    }
  }
  return out;
};

const readAll = async (filePath: string): Promise<Result<unknown[], HubError>> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok([]);
    return { ok: false, error: fileError(`read failed for ${path.basename(filePath)}: ${code}`, e) };
  }
  return ok(parseLines(raw));
};

/** Log-file half of the jsonl_store adapter (docs/01 §Package layout:
 * "SummaryStore + log append/replay over logs/<id>.jsonl and summaries.jsonl"). */
export type LogStore = {
  /** append one rendered log line to logs/<sessionId>.jsonl (created on first
   * append); the first line of a session log is the system session_start event */
  appendLog(entry: StoredLogEntry): Promise<Result<void, HubError>>;
  /** last n entries of a session log, oldest of the tail first; f narrows before slicing */
  tailLog(sessionId: string, n: number, f?: LogFilter): Promise<Result<StoredLogEntry[], HubError>>;
  /** full replay of a session log, oldest first */
  replayLog(sessionId: string, f?: LogFilter): Promise<Result<StoredLogEntry[], HubError>>;
};

/** JsonlStore: the SummaryStore port plus the log-file half. The hub process
 * is the single writer (flock owned by the host); surfaces only read. */
export const createJsonlStore = (dataRoot: string): SummaryStore & LogStore => ({
  async append(line) {
    return appendLine(summariesPath(dataRoot), line);
  },

  async tail(n, f) {
    const all = await readAll(summariesPath(dataRoot));
    if (!all.ok) return all;
    const lines = all.value as SummaryLine[];
    return ok(lines.filter((line) => matchesSummary(line, f)).slice(-n));
  },

  async appendLog(entry) {
    return appendLine(logPath(dataRoot, entry.sessionId), toStored(entry));
  },

  async tailLog(sessionId, n, f) {
    const all = await readAll(logPath(dataRoot, sessionId));
    if (!all.ok) return all;
    const entries = all.value as StoredLogEntry[];
    return ok(entries.filter((e) => matchesLogFilter(e, f)).slice(-n));
  },

  async replayLog(sessionId, f) {
    const all = await readAll(logPath(dataRoot, sessionId));
    if (!all.ok) return all;
    const entries = all.value as StoredLogEntry[];
    return ok(entries.filter((e) => matchesLogFilter(e, f)));
  },
});
