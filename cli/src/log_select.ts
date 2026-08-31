// cli/src/log_select.ts — `[id]` resolution for the read-only log views
// (docs/03-cli.md §Subcommands shared conventions: prefix match, ambiguous →
// candidates, no match → not_found; optional id → picker over open sessions,
// TTY required — machine modes never prompt).

import type { StatusFile } from "@yurifrl/hub";
import { resolveSessionArg, pickSessionInteractive, type SessionLike } from "./pick_session";

/** status.json sessions → picker/resolver views (open only). */
export const openSessionsFromStatus = (status: StatusFile | null): SessionLike[] =>
  status === null
    ? []
    : Object.entries(status.sessions)
        .filter(([, rec]) => rec.status === "open")
        .map(([id, rec]) => ({
          id,
          name: id.slice(0, 8),
          ...(rec.description !== undefined ? { description: rec.description } : {}),
          ...(rec.title !== undefined ? { title: rec.title } : {}),
          ...(rec.phase !== undefined ? { phase: rec.phase } : {}),
        }));

/**
 * Resolve the optional `<id>` of a read-only view: given → prefix-resolve
 * against candidates; omitted → picker (no TTY → usage exit 1 per docs/03
 * §Subcommands). Returns the full sessionId.
 */
export const resolveIdArg = async (
  ctx: Parameters<typeof resolveSessionArg>[0],
  candidates: SessionLike[],
  id: string | undefined,
  purpose: string,
): Promise<string> => {
  if (id !== undefined) return resolveSessionArg(ctx as never, candidates, id);
  return pickSessionInteractive(ctx as never, candidates, purpose);
};
