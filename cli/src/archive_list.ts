// cli/src/archive_list.ts — read-only archive reader (docs/02 §archive,
// docs/03 §Subcommands archive LIST mode): archive/YYYY-MM/*.json, newest
// first. The CLI never writes under ~/.hub (docs/03 §bin single-writer rule).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ArchiveEntry = {
  id: string;
  closedAt: string;
  closedBy: string;
  /** as-stored summary; renderer truncates */
  finalSummary: string;
  /** archive-relative path, e.g. archive/2026-08/s-c0de.json */
  path: string;
};

/** Read one archive record; unreadable files are skipped (listing degrades). */
const readRecord = (abs: string, rel: string): ArchiveEntry | null => {
  try {
    const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : rel.replace(/^.*\//, "").replace(/\.json$/, "");
    const closedAt = typeof raw.closedAt === "string" ? raw.closedAt : "";
    const closedBy = typeof raw.closedBy === "string" ? raw.closedBy : "";
    const finalSummary = typeof raw.finalSummary === "string" ? raw.finalSummary : "";
    return { id, closedAt, closedBy, finalSummary, path: rel };
  } catch {
    return null;
  }
};

/**
 * All archive records, newest first (docs/03 §Subcommands archive: table
 * newest first). Throws when the archive directory itself is unreadable —
 * callers map that to usage 1 with the path in the message.
 */
export const listArchive = (dataRoot: string): ArchiveEntry[] => {
  const months = (() => {
    try {
      return readdirSync(join(dataRoot, "archive")).sort().reverse();
    } catch (e) {
      throw new Error(`cannot list ${join(dataRoot, "archive")}: ${(e as Error).message}`);
    }
  })();
  const out: ArchiveEntry[] = [];
  for (const month of months) {
    let files: string[];
    try {
      files = readdirSync(join(dataRoot, "archive", month));
    } catch {
      continue; // a vanished month degrades, the directory error does not
    }
    for (const f of files.sort().reverse()) {
      if (!f.endsWith(".json")) continue;
      const rel = `archive/${month}/${f}`;
      const rec = readRecord(join(dataRoot, "archive", month, f), rel);
      if (rec !== null) out.push(rec);
    }
  }
  // newest first by closedAt within the filesystem order (months reversed already)
  return out.sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0));
};
