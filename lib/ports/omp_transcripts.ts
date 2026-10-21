// lib/ports/omp_transcripts.ts — OmpTranscriptStore: one machine-wide scan of
// the omp transcript tree (docs/02 §sessions). Imports domain only
// (docs/01-architecture.md §Core abstractions ports).

import type { Result, HubError } from "../domain/command";
import type { OmpSessionFact, OmpSessionsResult } from "../domain/omp_sessions";

export type OmpTranscriptStore = {
  /** full machine scan: every session dir's transcripts → facts (id, cwd,
   * title, model, mtime, saidBye) + per-file errors. The roster merge is the
   * caller's (hub_core owns the hub session map — docs/02 §sessions). Whole-
   * root failures are values via Result; per-file problems land in `errors`. */
  scan(): Promise<Result<OmpTranscriptScan, HubError>>;
};

/** The scan result: facts for the merge, plus empty sessions/detached/errors
 * scaffolding the caller fills (the OmpSessionsResult shape of docs/02 §ops). */
export type OmpTranscriptScan = OmpSessionsResult & { facts: OmpSessionFact[] };

