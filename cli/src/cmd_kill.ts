// cli/src/cmd_kill.ts — `hub kill <id> [--yes]` (docs/03-cli.md §Subcommands):
// red confirm `kill <name>? [y/N]` default N; --yes skips; machine modes and
// non-TTY stdin never prompt and never assume consent → usage 1 without
// --yes; cmd `kill {name}`; human `✓ killed <name> — archived to
// archive/YYYY-MM/<id>.json`; --json {killed:true, id, archivedTo}.

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { listOp, runOp } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith, failReply } from "./cmd_mutation_helpers";
import { resolveSessionArg } from "./pick_session";
import { sessionLikes } from "./session_like";
import { displayName } from "./display_name";
import { confirmLine } from "./io";

/** Consent gate (docs/03 §Subcommands kill). Returns when consent is clear; exits 0 on decline. */
export const killConsent = async (ctx: CommandContext, name: string, yes: boolean): Promise<void> => {
  if (yes) return;
  const interactive = ctx.io.stdin.isTTY === true && ctx.policy.format === "human";
  if (!interactive) {
    // machine modes and non-TTY stdin never assume consent (docs/03 §Subcommands kill)
    return failWith(ctx, "usage", "kill: refusal requires consent — pass --yes or confirm interactively");
  }
  const confirmed = await confirmLine(ctx.io, `kill ${name}? [y/N] `);
  if (!confirmed) {
    // declined → exit 0, no changes, no envelope (docs/03 §Exit codes row 0)
    emitResult(() => {});
    throw new KillDeclined();
  }
};

/** Internal signal: the human declined; bin maps it to a silent exit 0. */
export class KillDeclined extends Error {}

export const cmdKill = async (ctx: CommandContext, id: string, opts: { yes?: boolean }): Promise<void> => {
  const listing = await listOp(ctx);
  if (!listing.ok) failReply(ctx, listing);
  const data = (listing.ok ? listing.result : {}) as {
    sessions?: Record<string, Record<string, unknown>>;
  };
  const sessions = data.sessions ?? {};
  const sessionId = resolveSessionArg(ctx, sessionLikes(sessions, () => true), id);
  const name = displayName(sessionId, sessions);

  await killConsent(ctx, name, opts.yes === true);

  // cmd frame kill {name} (docs/03 §Subcommands kill)
  const reply = await runOp(ctx, "kill", { name });
  if (!reply.ok) failReply(ctx, reply);

  const result = (reply.ok ? reply.result : {}) as { closedAt?: unknown; path?: unknown; archivedTo?: unknown };
  const archivedTo =
    typeof result.path === "string"
      ? result.path
      : typeof result.archivedTo === "string"
        ? result.archivedTo
        : archivePathGuess(reply.ok ? result.closedAt : undefined, sessionId);

  if (ctx.policy.format === "human") {
    emitResult(() => {
      ctx.io.stdout.write(`✓ killed ${name} — archived to ${archivedTo}\n`);
    });
    return;
  }
  const format = ctx.policy.format;
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ killed: true, id: sessionId, archivedTo }), format);
  });
};

/** archive/YYYY-MM/<id>.json from closedAt (UTC month), current month when unknown. */
export const archivePathGuess = (closedAt: unknown, id: string): string => {
  const t = typeof closedAt === "string" ? Date.parse(closedAt) : Number.NaN;
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `archive/${ym}/${id}.json`;
};
