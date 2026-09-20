// lib/adapters/fs_archive_store.ts — ArchiveStore over <dataRoot>/archive/.
// Port implementation; all I/O; imports ports + domain. File shape owned by
// docs/02 §archive: one immutable record per closed session under the UTC
// month of closedAt, written once — a second write of the same id is a busy
// error, never an overwrite (same durability bar as status.json: serialize →
// write <id>.json.tmp → fsync → rename(2); a crashed write leaves a stale
// <id>.json.tmp, never a half-written record).

import { mkdir, open, rename, stat } from "node:fs/promises";
import path from "node:path";
import { hubError } from "../domain/command";
import type { HubError, Result } from "../domain/command";
import type { ArchiveRecord } from "../domain/session";
import type { ArchiveStore } from "../ports/archive_store";

const TMP_SUFFIX = ".tmp";

/** UTC month directory of the record's closedAt (docs/02 §archive). */
const monthOf = (closedAt: string): string => {
    const d = new Date(closedAt);
    const at = Number.isNaN(d.getTime()) ? new Date() : d;
    return `${at.getUTCFullYear()}-${`${at.getUTCMonth() + 1}`.padStart(2, "0")}`;
};

/** Relative path form carried by the archived[] tombstone link. */
const relPath = (closedAt: string, id: string): string => `archive/${monthOf(closedAt)}/${id}.json`;

const writeRecord = async (dataRoot: string, record: ArchiveRecord): Promise<Result<string, HubError>> => {
    const rel = relPath(record.closedAt, record.id);
    const file = path.join(dataRoot, rel);
    const tmp = `${file}${TMP_SUFFIX}`;
    try {
        const existing = await stat(file);
        if (existing.isFile()) {
            return { ok: false, error: hubError("denied", `archive record ${rel} already exists (written once, never rewritten)`, { retryable: false }) };
        }
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
            return { ok: false, error: hubError("unavailable-hub", `archive dir unreadable at ${path.dirname(file)}: ${code ?? "error"}`, { retryable: false }) };
        }
    }
    try {
        await mkdir(path.dirname(file), { recursive: true });
        const handle = await open(tmp, "w");
        try {
            await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(tmp, file);
        return { ok: true, value: rel };
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "error";
        return { ok: false, error: hubError("unavailable-hub", `archive write failed for ${rel}: ${code}`, { retryable: false }) };
    }
};

/** Archive store over the hub data root. No I/O until write(). */
export const createFsArchiveStore = (dataRoot: string): ArchiveStore => ({
    write: (record) => writeRecord(dataRoot, record),
});
