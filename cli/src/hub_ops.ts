// cli/src/hub_ops.ts — typed thin wrappers over the context's socket client
// (docs/02 §Ops; docs/03 §bin boot sequence). Bodies call these; tests stub
// ctx.cmd instead of a socket. Never throws — failures come back as
// normalized outcomes (docs/01 §Error model).

import type { CommandContext } from "./commands";

/** One cmd/reply round-trip, normalized to a CmdOutcome. */
export type CmdOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/** Full status snapshot — the client-side prefix-resolution source (docs/03 §Subcommands). */
export type ListResult = {
  hub?: Record<string, unknown>;
  sessions?: Record<string, Record<string, unknown>>;
  attention?: Array<Record<string, unknown>>;
  archived?: Array<Record<string, unknown>>;
};

/** One cmd/reply round-trip through the context's client (tests stub ctx.cmd). */
export const runOp = async (
  ctx: Pick<CommandContext, "cmd">,
  op: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<CmdOutcome> => {
  const out = await ctx.cmd(op, args, timeoutMs);
  if ("result" in out) return { ok: true, result: out.result };
  return { ok: false, code: out.error.code, message: out.error.message };
};

/** The `list` snapshot op — prefix resolution source for every mutation body. */
export const listOp = (ctx: Pick<CommandContext, "cmd">): Promise<CmdOutcome> => runOp(ctx, "list", {});

/** Tool wait budget (docs/03 §Subcommands `tool`): max(replyTimeoutMs, wait × 1000). */
export const toolBudgetMs = (config: Pick<CommandContext["config"], "replyTimeoutMs">, waitSeconds: number): number =>
  Math.max(config.replyTimeoutMs, waitSeconds * 1000);
