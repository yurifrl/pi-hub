// lib/ports/archive_store.ts — ArchiveStore: one immutable close record per
// session, filed archive/YYYY-MM/<id>.json (docs/02 §archive).
// Imports domain only (docs/01-architecture.md §Package layout, §Core
// abstractions ports).

import type { Result, HubError } from "../domain/command";
import type { ArchiveRecord } from "../domain/session";

export type ArchiveStore = {
  /** durable write of the close record; resolves the relative path
   * ("archive/YYYY-MM/<id>.json") the archived[] tombstone link carries.
   * Written once — a second write of the same id is a busy error, never an
   * overwrite. The record must be durably in place before the caller's
   * single atomic status.json rewrite (docs/02 §invariant 2). */
  write(record: ArchiveRecord): Promise<Result<string, HubError>>;
};
