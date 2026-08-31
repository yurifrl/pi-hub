// lib/adapters/json_store.ts — StatusStore over <dataRoot>/status.json.
// Port implementation; all I/O; imports ports + domain (docs/01-architecture.md §Package layout).
// Wire/file shape owned by docs/02-data-contracts.md §status.json: atomic rewrite is
// serialize → write status.json.tmp → fsync → rename(2); readers never lock and see
// either the previous or the next complete object. A stale status.json.tmp is left
// behind by a crash between write and rename; the hub unlinks it on start
// (removeStaleTmp below).

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
 * mutation fills in the real meta block (startedAt, pid) before the write. */
const emptyStatus = (): StatusFile => ({
  version: 1,
  startedAt: "",
  pid: 0,
  nextAttentionId: 1,
  sessions: {},
  attention: [],
  archived: [],
});

const fileError = (message: string, cause: unknown): HubError =>
  hubError("unavailable-hub", message, { retryable: false, cause });

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Read + parse status.json. Tolerant in the forward-compat sense (unknown
 * fields pass through untouched). `updateMode` gates update(): a corrupt file
 * must never be silently replaced (data loss) — read() reports the error while
 * update() treats only a *missing* file as the empty skeleton. */
const readStatus = async (dataRoot: string, updateMode: boolean): Promise<Result<StatusFile, HubError>> => {
  let raw: string;
  try {
    raw = await readFile(statusPath(dataRoot), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && updateMode) {
      // boot path: no file yet — the mutation seeds the meta block from scratch
      return ok(emptyStatus());
    }
    if (code === "ENOENT") {
      return { ok: false, error: fileError(`no status.json under ${dataRoot}`, e) };
    }
    return { ok: false, error: fileError(`status.json unreadable: ${code ?? "error"}`, e) };
  }
  try {
    const parsed = JSON.parse(raw) as StatusFile;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "number") {
      return { ok: false, error: fileError("status.json malformed: missing version field", undefined) };
    }
    return ok(parsed);
  } catch (e) {
    // torn file (crash without rename should be impossible, but a bad manual
    // edit or disk corruption lands here) — error, never a silent reset
    return { ok: false, error: fileError("status.json invalid JSON", e) };
  }
};

/** The atomic rewrite primitive (docs/02 §Atomic rewrite): write the tmp file,
 * fsync it, rename over the target. On success the tmp name no longer exists. */
const atomicWrite = async (dataRoot: string, json: string): Promise<Result<void, HubError>> => {
  try {
    await mkdir(dataRoot, { recursive: true });
    const handle = await open(tmpPath(dataRoot), "w");
    try {
      await handle.writeFile(json, "utf8");
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
 * is the single writer (flock owned by the host); the store enforces only the
 * read/update/atomic-write mechanics. */
export const createJsonStore = (dataRoot: string): StatusStore => ({
  async read() {
    return readStatus(dataRoot, false);
  },

  async update(mutate) {
    // Missing file → start from the skeleton so boot can seed the meta block
    // through the same port; corrupt file → hard error (no silent reset).
    const current = await readStatus(dataRoot, true);
    if (!current.ok) return current;
    const next = mutate(current.value);
    const written = await atomicWrite(dataRoot, JSON.stringify(next, null, 2) + "\n");
    if (!written.ok) return written;
    return ok(next);
  },
});

/** Unlink a stale status.json.tmp left by a crashed writer (docs/02: "A stale
 * status.json.tmp is unlinked by the hub on start"). Safe to call always. */
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
