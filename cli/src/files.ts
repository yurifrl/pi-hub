// cli/src/files.ts — the one file reader (docs/03-cli.md §bin boot sequence):
// read-only commands (log, summaries, archive listing) read ~/.hub files
// directly — no socket, work while the hub is down. The CLI never writes
// under ~/.hub (docs/03 §bin Decision: single-writer rule).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { parseLogLines } from "./log_entry";
import { join } from "node:path";
import type { LogEntry, StatusFile, SummaryLine } from "@yurifrl/hub";
import type { HubCliConfig } from "./config";

export type HubFiles = {
  /** logs/<id>.jsonl — every parsed entry, oldest first */
  logEntries(sessionId: string): LogEntry[];
  /** summaries.jsonl — last `tail` lines (default 20), oldest first */
  summaryLines(tail?: number): SummaryLine[];
  /** status.json — null when absent (hub not started yet) */
  status(): StatusFile | null;
  /** the `limit` most recently modified logs/<id>.jsonl ids, newest first (watch rail) */
  recentLogIds(limit: number): string[];
};

/** One JSONL line → parsed value or null (skip blanks and corrupt lines). */
const parseJsonlLine = (line: string): unknown => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

export const makeFileReader = (config: HubCliConfig): HubFiles => ({
  logEntries(sessionId) {
    const path = join(config.dataRoot, "logs", `${sessionId}.jsonl`);
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      return []; // session open but log file absent — caller renders "no entries yet"
    }
    return parseLogLines(body);
  },

  summaryLines(tail = 20) {
    const path = join(config.dataRoot, "summaries.jsonl");
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      return []; // absent summaries.jsonl is an empty rail, not an error
    }
    const lines = body
      .split("\n")
      .map(parseJsonlLine)
      .filter((v): v is SummaryLine => v !== null && typeof v === "object" && "kind" in (v as object));
    return lines.slice(-tail);
  },

  status() {
    const path = join(config.dataRoot, "status.json");
    try {
      return JSON.parse(readFileSync(path, "utf8")) as StatusFile;
    } catch {
      return null;
    }
  },

  recentLogIds(limit) {
    const dir = join(config.dataRoot, "logs");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => {
        let mtime = 0;
        try {
          mtime = statSync(join(dir, n)).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { id: n.slice(0, -".jsonl".length), mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(0, limit))
      .map((e) => e.id);
  },
});

/** archive/YYYY-MM/*.json directory names, newest first; exported for archive listing (tk-tku). */
export const archiveMonths = (config: HubCliConfig): string[] => {
  try {
    return readdirSync(join(config.dataRoot, "archive")).sort().reverse();
  } catch {
    return [];
  }
};
