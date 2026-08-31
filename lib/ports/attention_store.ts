// lib/ports/attention_store.ts — AttentionStore: list/raise/resolve attention items.
// Imports domain only (docs/01-architecture.md §Core abstractions ports).

import type { Result, HubError, Caller } from "../domain/command";
import type { AttentionItem } from "../domain/session";
import type { AttentionCandidate } from "../domain/attention";
import type { Filter } from "../domain/filter";

export type AttentionStore = {
  list(f?: Filter): Result<AttentionItem[], HubError>;
  raise(c: AttentionCandidate): Promise<Result<AttentionItem, HubError>>;
  resolve(id: string, answer: string | undefined, by: Caller): Promise<Result<AttentionItem, HubError>>;
};
