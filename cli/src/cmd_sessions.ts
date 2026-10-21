// cli/src/cmd_sessions.ts — `hub sessions` (docs/03-cli.md §Subcommands sessions):
// machine-wide omp inventory over op "sessions" (docs/02 §Sessions op). One
// cmd/reply round-trip; the hub owns the roster ∪ transcript merge (roster
// rows win by id). Human rows `id · title · cwd · model · status`; unknown
// transcripts show status `detached`; ids whose transcripts went quiet past
// the freshness window arrive in `detached[]` — printed as a muted
// `detached (quiet)` tail instead of a row. --json / --ndjson snapshot
// `{sessions, detached}` rows verbatim from the reply; scan warnings render
// as muted stderr lines in human mode only.

import type { CommandContext } from "./commands";
import { runOp } from "./hub_ops";
import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { emitResult } from "./emit";
import { failReply } from "./cmd_mutation_helpers";
import { mutedRow, renderRow, colorLevelFor } from "./log_render";

type SessionRow = {
  id?: unknown;
  status?: unknown;
  kind?: unknown;
  cwd?: unknown;
  title?: unknown;
  model?: unknown;
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** `id · title · cwd · model · status` — the docs/03 row contract. */
const rowLine = (r: SessionRow): string =>
  [text(r.id), text(r.title), text(r.cwd), text(r.model), text(r.status)].join(" · ");

export const cmdSessions = async (ctx: CommandContext): Promise<void> => {
  const reply = await runOp(ctx, "sessions", {});
  if (!reply.ok) return failReply(ctx, reply);
  const { sessions, detached, errors } = reply.result as {
    sessions: SessionRow[];
    detached: string[];
    errors?: string[];
  };

  const format = ctx.policy.format;
  if (format === "human") {
    const level = colorLevelFor(ctx);
    return emitResult(() => {
      for (const warn of errors ?? []) ctx.io.stderr.write(renderRow(mutedRow(`warn: ${warn}`), level) + "\n");
      if (sessions.length === 0 && detached.length === 0) {
        ctx.io.stdout.write("(no sessions)\n");
        return;
      }
      for (const r of sessions) ctx.io.stdout.write(rowLine(r) + "\n");
      // quiet ids never got a row (docs/02 §Sessions op); the muted tail keeps
      // them visible without mixing them into the live inventory
      for (const id of detached) ctx.io.stdout.write(renderRow(mutedRow(`detached (quiet) ${id}`), level) + "\n");
    });
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ sessions, detached }), format);
  });
};
