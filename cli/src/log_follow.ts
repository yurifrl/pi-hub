// cli/src/log_follow.ts — tail follower for `log -f` and watch's live log
// pane (docs/03-cli.md §log: "print appended lines, survive truncate/rotate";
// §Refresh: log pane keeps working from logs/*.jsonl). Pure polling tail:
// stat + read the whole file each tick, track byte offset + inode. Truncate
// (size < offset or inode change) resets and re-reads. Tests drive a fake
// read/stat pair or real temp files — never sleeps at the assertion level
// (docs/01 §Testing); the interval runs only in the concrete host wiring.

import { readFileSync, statSync } from "node:fs";
import type { LogEntry } from "@yurifrl/hub";

/** One decoded follow step — the caller renders incrementally. */
export type FollowStep = {
  entries: LogEntry[];
  /** inode changed (rotate) — caller may clear its pane model */
  rotated: boolean;
  /** file shrank below the tracked offset (truncate) */
  truncated: boolean;
};

export type LogFollower = {
  /** one tail step: entries appended since the last call */
  step(): FollowStep;
};

const entryOk = (v: unknown): v is LogEntry => v !== null && typeof v === "object" && "kind" in (v as object);

const parseLines = (body: string): LogEntry[] =>
  body
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(entryOk);

/** Real host IO — injected so tests can fake the filesystem layer. */
export type FollowIo = {
  read: (path: string) => string;
  stat: (path: string) => { size: number; ino: number } | null;
};

export const nodeFollowIo = (): FollowIo => ({
  read: (path) => readFileSync(path, "utf8"),
  stat: (path) => {
    try {
      const s = statSync(path);
      return { size: s.size, ino: s.ino };
    } catch {
      return null; // file absent (no entries yet) — not an error
    }
  },
});

/**
 * Offset-tracking tail over one log file. First `step()` returns the whole
 * existing content (tail semantics — the viewer wants the recent past too);
 * later steps return only appended entries.
 */
export const makeLogFollower = (io: FollowIo, path: string): LogFollower => {
  let offset = 0;
  let ino: number | null = null;
  return {
    step(): FollowStep {
      const st = io.stat(path);
      if (st === null) return { entries: [], rotated: false, truncated: false };
      if (ino !== null && st.ino !== ino) {
        // rotation: fresh file, replay everything
        ino = st.ino;
        offset = 0;
        const entries = parseLines(io.read(path));
        offset = st.size;
        return { entries, rotated: true, truncated: false };
      }      if (st.size < offset) {
        // truncate: reset and re-read
        offset = 0;
        const entries = parseLines(io.read(path));
        offset = st.size;
        return { entries, rotated: false, truncated: true };
      }
      const body = io.read(path);
      const fresh = body.slice(offset);
      offset = st.size;
      ino = st.ino; // track inode so a later rotation (rename+recreate) is detected
      return { entries: parseLines(fresh), rotated: false, truncated: false };
    },
  };
};
