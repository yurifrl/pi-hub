// cli/src/cmd_tool.ts — `hub tool <id> <tool> [json]` (docs/03-cli.md
// §Subcommands): [json] parsed strictly (parse fail → usage 1 with the parse
// error); --wait seconds, budget max(replyTimeoutMs, wait×1000); human result
// card truncated at 50 lines; --json {ok, result} verbatim.

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { listOp, runOp, toolBudgetMs } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith, failReply } from "./cmd_mutation_helpers";
import { resolveSessionArg } from "./pick_session";
import { sessionLikes } from "./session_like";
import { displayName } from "./display_name";

/** Pretty-print `value` as lines (strings raw, everything else JSON pretty). */
export const resultLines = (value: unknown): string[] => {
  if (typeof value === "string") return value.split("\n");
  return JSON.stringify(value, null, 2).split("\n");
};

/** Truncate at 50 lines with a `… N more` footer (docs/03 §Subcommands tool). */
export const truncateLines = (lines: string[], max = 50): { shown: string[]; more: number } => {
  if (lines.length <= max) return { shown: lines, more: 0 };
  return { shown: lines.slice(0, max), more: lines.length - max };
};

export const cmdTool = async (
  ctx: CommandContext,
  id: string,
  tool: string,
  jsonArg: string | undefined,
  waitSeconds: number | undefined,
): Promise<void> => {
  // 1) strict [json] parse — usage 1 with the parse error in the message
  let args: unknown;
  if (jsonArg !== undefined) {
    try {
      args = JSON.parse(jsonArg);
    } catch (e) {
      return failWith(ctx, "usage", `tool: invalid JSON argument: ${(e as Error).message}`);
    }
  }

  // 2) resolve the target prefix against the list snapshot
  const listing = await listOp(ctx);
  if (!listing.ok) failReply(ctx, listing);
  const data = (listing.ok ? listing.result : {}) as {
    sessions?: Record<string, Record<string, unknown>>;
  };
  const sessions = data.sessions ?? {};
  const sessionId = resolveSessionArg(ctx, sessionLikes(sessions, () => true), id);

  // 3) cmd frame tool {target, tool, args} with the wait budget
  const budgetMs = toolBudgetMs(ctx.config, waitSeconds ?? 30);
  const reply = await runOp(ctx, "tool", { target: sessionId, tool, ...(args !== undefined ? { args } : {}) }, budgetMs);
  if (!reply.ok) failReply(ctx, reply);
  const result = reply.ok ? reply.result : undefined;

  // 4) output
  const name = displayName(sessionId, sessions);
  const format = ctx.policy.format;
  if (format === "human") {
    emitResult(() => {
      ctx.io.stdout.write(`▎tool ${tool} → ${name}\n`);
      const lines = resultLines(result);
      const { shown, more } = truncateLines(lines);
      for (const line of shown) ctx.io.stdout.write(`${line}\n`);
      if (more > 0) ctx.io.stdout.write(`… ${more} more\n`);
    });
    return;
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ ok: true, result }), format);
  });
};
