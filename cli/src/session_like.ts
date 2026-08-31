// cli/src/session_like.ts — status-snapshot sessions → picker views
// (docs/03-cli.md §Subcommands: picker rows carry name/id/description/phase).

import type { SessionLike } from "./pick_session";

/** Map a `list` reply sessions map through a filter into picker views. */
export const sessionLikes = (
  sessions: Record<string, Record<string, unknown>>,
  filter: (rec: Record<string, unknown>) => boolean,
): SessionLike[] =>
  Object.entries(sessions)
    .filter(([, rec]) => filter(rec))
    .map(([id, rec]) => ({
      id,
      name: typeof rec.name === "string" && rec.name.length > 0 ? rec.name : id.slice(0, 8),
      ...(typeof rec.description === "string" ? { description: rec.description } : {}),
      ...(typeof rec.title === "string" ? { title: rec.title } : {}),
      ...(typeof rec.phase === "string" ? { phase: rec.phase } : {}),
    }));
