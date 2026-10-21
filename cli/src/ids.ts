// cli/src/ids.ts — id-prefix resolution + roster parsing shared by the socket commands.
// Pure: callers fetch the roster (`ctx.call("list")`) and hand the candidates in.

import { basename } from "node:path";
import { CliError } from "./errors";

/**
 * Resolve `query` against `candidates`: an exact id wins; otherwise a unique
 * prefix. No match → not_found; several → ambiguous with the candidate ids in detail.
 */
export const resolveId = <T extends { id: string }>(query: string, candidates: readonly T[], label: string): T => {
  const exact = candidates.find((c) => c.id === query);
  if (exact) return exact;
  const hits = query === "" ? [] : candidates.filter((c) => c.id.startsWith(query));
  if (hits.length === 1) return hits[0] as T;
  if (hits.length === 0) throw new CliError("not_found", `no ${label} matches "${query}"`);
  throw new CliError(
    "ambiguous",
    `"${query}" matches ${hits.length} ${label}s: ${hits.map((h) => h.id).join(", ")}`,
    hits.map((h) => h.id),
  );
};

export type RosterSession = {
  id: string;
  cwd: string;
  title: string;
  phase: string;
  model: string;
  description?: string;
};

export type AttentionRow = {
  id: string;
  sessionId: string;
  kind: string;
  text: string;
  resolvedAt?: string;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Sessions of a `list` reply, id folded into each row. Tolerates the map or an array shape. */
export const rosterOf = (reply: unknown): RosterSession[] => {
  if (!isObj(reply)) return [];
  const s = reply.sessions;
  const rows: Array<[string, unknown]> = Array.isArray(s)
    ? s.map((r): [string, unknown] => [isObj(r) ? str(r.id) : "", r])
    : isObj(s)
      ? Object.entries(s)
      : [];
  const out: RosterSession[] = [];
  for (const [id, rec] of rows) {
    if (!id || !isObj(rec)) continue;
    const description = str(rec.description);
    out.push({
      id,
      cwd: str(rec.cwd),
      title: str(rec.title),
      phase: str(rec.phase),
      model: str(rec.model),
      ...(description ? { description } : {}),
    });
  }
  return out;
};

/** Open (unresolved) attention items of a `list` reply. */
export const openAttentionOf = (reply: unknown): AttentionRow[] => {
  if (!isObj(reply) || !Array.isArray(reply.attention)) return [];
  const out: AttentionRow[] = [];
  for (const raw of reply.attention) {
    if (!isObj(raw) || raw.resolvedAt !== undefined || !str(raw.id)) continue;
    out.push({ id: str(raw.id), sessionId: str(raw.sessionId), kind: str(raw.kind), text: str(raw.text) });
  }
  return out;
};

/** Display name: cwd basename, falling back to the id's first 8 chars. */
export const sessionName = (id: string, roster: readonly RosterSession[]): string => {
  const rec = roster.find((r) => r.id === id);
  const base = rec?.cwd ? basename(rec.cwd) : "";
  return base || id.slice(0, 8);
};
