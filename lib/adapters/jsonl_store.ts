// lib/adapters/jsonl_store.ts — SummaryStore over <dataRoot>/summaries.jsonl plus
// append/tail/replay for per-session logs/<id>.jsonl.
// Port implementation; all I/O; imports ports + domain (docs/01-architecture.md §Package layout).
// File shapes owned by docs/02-data-contracts.md (## logs, ## summaries.jsonl):
// append-only, one JSON object per line, durability = a single write(2) at O_APPEND
// per line; on read a trailing line without a newline is discarded (torn tail);
// files are never rewritten or compacted.

import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { hubError } from "../domain/command";
import type { HubError, Result } from "../domain/command";
import type { LogEntry, SummaryLine } from "../domain/session";
import { matchesSummary } from "../domain/filter";
import type { SummaryStore } from "../ports/summary_store";

const SUMMARIES_FILE = "summaries.jsonl";
const LOGS_DIR = "logs";

const summariesPath = (dataRoot: string): string => path.join(dataRoot, SUMMARIES_FILE);
const logPath = (dataRoot: string, sessionId: string): string =>
    path.join(dataRoot, LOGS_DIR, `${sessionId}.jsonl`);

const fileError = (message: string, cause?: unknown): HubError =>
    hubError("unavailable-hub", message, { retryable: false, cause });

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Filter for log entries. Deliberately local: domain `Filter.kind` is the
 * AttentionKind vocabulary, disjoint from LogEntry["kind"] — filtering log
 * lines through it would be always-false (tk-bfx validator note). Log reads
 * narrow on the entry's own kinds instead. */
export type LogFilter = {
    /** match entries of any of these log kinds */
    kind?: LogEntry["kind"][];
    /** substring match, case-insensitive, across text */
    text?: string;
};

/** One rendered log line as stored — mirrors LogEntry with `t` as the ISO
 * string docs/02 mandates on disk; unknown fields tolerated on read. */
export type StoredLogEntry = {
    t: string;
    sessionId: string;
    kind: LogEntry["kind"];
    text: string;
    meta?: Record<string, unknown>;
};

const matchesLogEntry = (entry: StoredLogEntry, f?: LogFilter): boolean => {
    if (!f) return true;
    if (f.kind !== undefined && f.kind.length > 0 && !f.kind.includes(entry.kind)) return false;
    if (f.text !== undefined && !entry.text.toLowerCase().includes(f.text.toLowerCase())) return false;
    return true;
};

/** Append one line to an append-only file with a single write(2) at O_APPEND.
 * Creates the file (and parents) on first append. The whole serialized line is
 * handed to one writeFile call — a crash may lose the tail of the last line
 * but never corrupts earlier ones. */
const appendLine = async (filePath: string, line: unknown): Promise<Result<void, HubError>> => {
    try {
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
 * line never fails the whole read. */
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
            // torn middle line: skip
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

/** Max chars of `text` kept per rendered log line (docs/02 ## logs: "tool
 * args/results are summarized, truncated to 2 KB per line"). Writer-side
 * helper — the reader tolerates longer lines, it never truncates. */
export const truncateLogText = (text: string, max = 2048): string =>
    text.length <= max ? text : text.slice(0, max);

/** Log-file half of the jsonl_store adapter (docs/01 §Package layout:
 * "SummaryStore + log append/replay over logs/<id>.jsonl and summaries.jsonl"). */
export type LogStore = {
    /** append one rendered log line to logs/<sessionId>.jsonl (created on first append) */
    appendLog(entry: LogEntry): Promise<Result<void, HubError>>;
    /** last n entries of a session log, oldest of the tail first; f narrows before slicing */
    tailLog(sessionId: string, n: number, f?: LogFilter): Promise<Result<StoredLogEntry[], HubError>>;
    /** full replay of a session log, oldest first */
    replayLog(sessionId: string, f?: LogFilter): Promise<Result<StoredLogEntry[], HubError>>;
};

/** JsonlStore: the SummaryStore port plus the log-file half. The hub process
 * is the single writer; surfaces read tails/replays for their log views. */
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
        return appendLine(logPath(dataRoot, entry.sessionId), entry);
    },

    async tailLog(sessionId, n, f) {
        const all = await readAll(logPath(dataRoot, sessionId));
        if (!all.ok) return all;
        const entries = all.value as StoredLogEntry[];
        return ok(entries.filter((e) => matchesLogEntry(e, f)).slice(-n));
    },

    async replayLog(sessionId, f) {
        const all = await readAll(logPath(dataRoot, sessionId));
        if (!all.ok) return all;
        const entries = all.value as StoredLogEntry[];
        return ok(entries.filter((e) => matchesLogEntry(e, f)));
    },
});
