// lib/adapters/json_store.ts — StatusStore over <dataRoot>/status.json.
// Port implementation; all I/O; imports ports + domain (docs/01-architecture.md §Package layout).
// File shape owned by docs/02-data-contracts.md §status.json: atomic rewrite is
// serialize → write status.json.tmp → fsync → rename(2); readers never lock and see
// either the previous or the next complete object, never a torn file. A crash between
// write and rename leaves a stale status.json.tmp behind; the hub unlinks it on start
// (removeStaleTmp). Single-writer enforcement (flock on hub.lock) is host responsibility;
// this store only guarantees that concurrent update() calls inside one process
// serialize and each lands as a complete object.

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { hubError } from "../domain/command";
import type { HubError, Result } from "../domain/command";
import type { StatusFile } from "../domain/session";
import type { StatusStore } from "../ports/status_store";

const STATUS_FILE = "status.json";
const TMP_SUFFIX = ".tmp";

const statusPath = (dataRoot: string): string => path.join(dataRoot, STATUS_FILE);
const tmpPath = (dataRoot: string): string => statusPath(dataRoot) + TMP_SUFFIX;

/** Skeleton a first update() starts from when no status.json exists yet; the
 * mutation fills in the real meta block (startedAt, pid) before the write.
 * `version` is the first key — the serialized file must open with it. */
const emptyStatus = (): StatusFile => ({
  version: 1,
  startedAt: "",
  pid: 0,
  nextAttentionId: 1,
  sessions: {},
  attention: [],
  archived: [],
});

const fileError = (message: string, cause?: unknown): HubError =>
  hubError("unavailable-hub", message, { retryable: false, cause });

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Serialize with `version` pinned as the first field of the meta block
 * (docs/02 §status.json invariant). */
const serialize = (status: StatusFile): string => {
  const { version, ...rest } = status;
  return JSON.stringify({ version, ...rest }, null, 2) + "\n";
};

/** Read + parse status.json. Tolerant in the forward-compat sense: unknown
 * fields pass through untouched at every level (docs/02 §Versioning). Corrupt
 * content is an error Result, never a silent reset. */
const readStatus = async (dataRoot: string): Promise<Result<StatusFile, HubError>> => {
  let raw: string;
  try {
    raw = await readFile(statusPath(dataRoot), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: fileError(`status.json unreadable: ${code ?? "error"}`, e) };
  }
  try {
    const parsed = JSON.parse(raw) as StatusFile;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "number") {
      return { ok: false, error: fileError("status.json malformed: missing version field") };
    }
    return ok(parsed);
  } catch (e) {
    // torn or hand-mangled file — error, never a silent reset
    return { ok: false, error: fileError("status.json invalid JSON", e) };
  }
};

/** The atomic rewrite primitive (docs/02 §Atomic rewrite): serialize, write the
 * tmp file, fsync, rename(2) over the target. On success the tmp name no longer
 * exists; readers observe only the previous or the next complete object. */
const atomicWrite = async (dataRoot: string, status: StatusFile): Promise<Result<void, HubError>> => {
  try {
    await mkdir(dataRoot, { recursive: true });
    const handle = await open(tmpPath(dataRoot), "w");
    try {
      await handle.writeFile(serialize(status), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath(dataRoot), statusPath(dataRoot));
    return ok(undefined);
  } catch (e) {
    return { ok: false, error: fileError("status.json write failed", e) };
  }
};

/** JsonStore: the StatusStore port over one status.json file. The hub process
 * is the single writer (flock owned by the host); within the process, update()
 * calls are serialized on a promise chain so concurrent mutations compose
 * instead of racing (read-mutate-write per call, last complete object wins). */
export const createJsonStore = (dataRoot: string): StatusStore => {
  let updates: Promise<unknown> = Promise.resolve();

  const updateOnce = async (mutate: (s: StatusFile) => StatusFile): Promise<Result<StatusFile, HubError>> => {
    const current = await readStatus(dataRoot);
    // Missing file → start from the skeleton so boot can seed the meta block
    // through the same port; corrupt file → hard error (no silent reset).
    const base =
      current.ok || (current.error.cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT"
        ? current
        : ok(emptyStatus());
    if (!base.ok) return base;
    let next: StatusFile;
    try {
      // a throwing mutate is a programmer error caught at the boundary so one
      // bad mutation can never corrupt the file or poison the update chain
      next = mutate(base.value);
    } catch (e) {
      return { ok: false, error: hubError("denied", `status.json mutation rejected: ${(e as Error).message}`, { retryable: false, cause: e }) };
    }
    const written = await atomicWrite(dataRoot, next);
    if (!written.ok) return written;
    return ok(next);
  };

  return {
    async read() {
      const current = await readStatus(dataRoot);
      if (current.ok || (current.error.cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return current;
      return { ok: false, error: fileError(`no status.json under ${dataRoot}`, current.error.cause) };
    },

    update(mutate) {
      const run = updates.then(() => updateOnce(mutate));
      // the chain only sequences work; a failed update must not poison the next
      updates = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
};

/** Unlink a stale status.json.tmp left by a crashed writer (docs/02 §Atomic
 * rewrite: "A stale status.json.tmp is unlinked by the hub on start"). Safe to
 * call always — a missing tmp is a success. */
export const removeStaleTmp = async (dataRoot: string): Promise<Result<void, HubError>> => {
  try {
    await unlink(tmpPath(dataRoot));
    return ok(undefined);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(undefined);
    return { ok: false, error: fileError(`stale ${STATUS_FILE}.tmp unlink failed: ${code}`, e) };
  }
};
