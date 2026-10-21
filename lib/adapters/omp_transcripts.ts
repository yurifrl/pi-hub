// lib/adapters/omp_transcripts.ts — OmpTranscriptStore over the omp transcript
// tree (docs/02 §sessions). Port implementation; all I/O; imports ports +
// domain (docs/01-architecture.md §Package layout). Walks
// <sessionsRoot>/<dir>/<name>.jsonl, reads each transcript's head
// (session/title/model lines) and tail (farewell lines), and produces
// OmpSessionFacts; the roster merge is the caller's (hub_core owns the hub
// session map — docs/02 §sessions).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { hubError } from "../domain/command";
import type { HubError, Result } from "../domain/command";
import type { OmpTranscriptStore } from "../ports/omp_transcripts";
import type { OmpSessionFact, OmpSessionsResult } from "../domain/omp_sessions";
import { factFromHead } from "../domain/omp_sessions";

const HEAD_BYTES = 8 * 1024; // session/title/model_change live in the first lines
const TAIL_BYTES = 4 * 1024; // farewell lines live at the end

/** One raw transcript read: head bytes + tail bytes, per the domain contract. */
const readBlob = (path: string, size: number): { head: string; tail: string } => {
  const buf = readFileSync(path);
  const head = buf.subarray(0, Math.min(HEAD_BYTES, buf.length)).toString("utf8");
  const tail = buf.length > TAIL_BYTES ? buf.subarray(Math.max(0, buf.length - TAIL_BYTES)).toString("utf8") : "";
  return { head, tail };
};

/** Every transcript file under the root: one readdir per session dir, one stat
 * per file (~1k files is cheap at the cadence ops run). A missing root or
 * unreadable dir is empty, never a throw — the scan is best-effort by design
 * (docs/02 §sessions: the op must not fail because of the machine's tree). */
const listTranscripts = (root: string): Array<{ dir: string; name: string; path: string; mtimeMs: number; size: number }> => {
  const out: Array<{ dir: string; name: string; path: string; mtimeMs: number; size: number }> = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const dirPath = `${root}/${dir}`;
    let names: string[] = [];
    try {
      names = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = `${dirPath}/${name}`;
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        out.push({ dir, name, path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        continue;
      }
    }
  }
  return out;
};

/** Compose the store. `sessionsRoot` arrives pre-resolved from HubEnv
 * (extensions/hub_env.ts); lib never reads process.env. */
export const createOmpTranscriptStore = (sessionsRoot: string): OmpTranscriptStore => ({
  scan: async (): Promise<Result<{ facts: OmpSessionFact[] } & OmpSessionsResult, HubError>> => {
    try {
      const facts: OmpSessionFact[] = [];
      const errors: string[] = [];
      for (const f of listTranscripts(sessionsRoot)) {
        try {
          const { head, tail } = readBlob(f.path, f.size);
          facts.push(factFromHead({ file: { dir: f.dir, name: f.name, mtimeMs: f.mtimeMs }, head, tail }));
        } catch (cause) {
          errors.push(`${f.dir}/${f.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      // sessions/detached stay empty here: the roster merge is the caller's
      // (hub_core's session map is authoritative). The port returns the raw
      // scan; docs/02 §sessions defines the merge location.
      return { ok: true, value: { sessions: [], detached: [], errors, facts } };
    } catch (cause) {
      return {
        ok: false,
        error: hubError("unavailable-hub", `omp transcript scan failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
          retryable: true,
          ...(cause !== undefined ? { cause } : {}),
        }),
      };
    }
  },
});
