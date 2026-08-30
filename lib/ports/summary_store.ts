// lib/ports/summary_store.ts — SummaryStore: append/tail summaries.jsonl.
// Imports domain only (docs/01-architecture.md §Core abstractions ports).

import type { Result, HubError } from "../domain/command";
import type { SummaryLine } from "../domain/session";
import type { Filter } from "../domain/filter";

export type SummaryStore = {
  append(line: SummaryLine): Promise<Result<void, HubError>>;
  tail(n: number, f?: Filter): Promise<Result<SummaryLine[], HubError>>;
};
