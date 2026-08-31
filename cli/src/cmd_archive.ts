// cli/src/cmd_archive.ts — `hub archive [id]` (docs/03-cli.md §Subcommands):
// LIST (no id) — read-only listing of archive/YYYY-MM/*.json, no socket;
// CLOSE (id) — cmd `archive {id}`, closes like kill with closedBy:"archive".

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { listOp, runOp } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith, failReply } from "./cmd_mutation_helpers";
import { resolveSessionArg } from "./pick_session";
import { sessionLikes } from "./session_like";
import { listArchive, type ArchiveEntry } from "./archive_list";

// ---- LIST mode (read-only, no socket — docs/03 §Subcommands archive) ----

export const cmdArchiveList = async (ctx: CommandContext): Promise<void> => {
  let entries: ArchiveEntry[];
  try {
    entries = listArchive(ctx.config.dataRoot);
  } catch (e) {
    return failWith(ctx, "usage", `archive: unreadable archive directory at ${ctx.config.dataRoot}/archive: ${(e as Error).message}`);
  }
  const format = ctx.policy.format;
  if (format === "human") {
    emitResult(() => {
      if (entries.length === 0) {
        ctx.io.stdout.write("(empty)\n");
        return;
      }
      for (const e of entries) {
        ctx.io.stdout.write(`${e.id} · ${e.closedAt} · ${e.closedBy} · ${e.finalSummary.slice(0, 60)}\n`);
      }
    });
    return;
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ entries }), format);
  });
};

// ---- CLOSE mode ----

export const cmdArchiveClose = async (ctx: CommandContext, id: string): Promise<void> => {
  const listing = await listOp(ctx);
  if (!listing.ok) failReply(ctx, listing);
  const data = (listing.ok ? listing.result : {}) as {
    sessions?: Record<string, Record<string, unknown>>;
  };
  const sessions = data.sessions ?? {};
  const sessionId = resolveSessionArg(ctx, sessionLikes(sessions, () => true), id);

  const reply = await runOp(ctx, "archive", { id: sessionId });
  if (!reply.ok) failReply(ctx, reply);

  const result = (reply.ok ? reply.result : {}) as { path?: unknown; archivedTo?: unknown };
  const path =
    typeof result.path === "string"
      ? result.path
      : typeof result.archivedTo === "string"
        ? result.archivedTo
        : `archive/${sessionId}.json`;

  if (ctx.policy.format === "human") {
    emitResult(() => {
      ctx.io.stdout.write(`✓ archived ${sessionId}\n`);
    });
    return;
  }
  const format = ctx.policy.format;
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ archived: true, id: sessionId, path }), format);
  });
};
