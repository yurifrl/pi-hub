// lib/ports/status_store.ts — StatusStore: read/update status.json atomically.
// Imports domain only (docs/01-architecture.md §Package layout, §Core abstractions ports).

import type { Result, HubError } from "../domain/command";
import type { StatusFile } from "../domain/session";

export type StatusStore = {
  read(): Promise<Result<StatusFile, HubError>>;
  /** atomic: the mutation runs against the current file and the whole result is written back */
  update(mutate: (s: StatusFile) => StatusFile): Promise<Result<StatusFile, HubError>>;
};
