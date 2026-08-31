// cli/src/resolve.ts — client-side resolution helpers (docs/03-cli.md
// §Subcommands shared conventions): <item>/<id> accept unique prefixes against
// the client-visible snapshot; ambiguous → "ambiguous" with candidates,
// no match → "not_found", both exit-1 class.

import { errorEnvelope, type OutputEnvelope } from "./envelope";

/** one resolvable entry: the id plus the strings a prefix may match */
export type Resolvable = {
  id: string;
  /** the human identity a prefix usually names (session name / item id) */
  keys: string[];
};

export type Resolution =
  | { ok: true; id: string }
  | { ok: false; envelope: OutputEnvelope };

/** substring match, case-insensitive — a prefix is an unanchored substring */
const matches = (candidate: string, prefix: string): boolean =>
  candidate.toLowerCase().includes(prefix.toLowerCase());

/**
 * Resolve `prefix` across `items` (each id + its keys). Zero matches →
 * not_found envelope; several → ambiguous with the candidate ids in detail
 * (docs/03 §Subcommands: candidates in `detail`). Exactly one → the id.
 */
export const resolvePrefix = (items: readonly Resolvable[], prefix: string): Resolution => {
  const hits = items.filter((it) => matches(it.id, prefix) || it.keys.some((k) => matches(k, prefix)));
  if (hits.length === 1) return { ok: true, id: (hits[0] as Resolvable).id };
  if (hits.length === 0) {
    return { ok: false, envelope: errorEnvelope("not_found", `no session or item matches "${prefix}"`) };
  }
  return {
    ok: false,
    envelope: errorEnvelope(
      "ambiguous",
      `"${prefix}" matches several candidates`,
      (hits as Resolvable[]).map((h) => h.id),
    ),
  };
};
