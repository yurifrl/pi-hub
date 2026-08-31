// cli/src/cmd_assign.ts — `hub assign [id] <task...>` (docs/03-cli.md
// §Subcommands): id optional → fuzzy picker over idle sessions only (needs
// TTY, else usage 1); cmd `assign {id, task}`; human
// `✓ assigned to <name> — <first line of task>`; --json
// {assigned:true, id, sessionId, task}.

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { listOp, runOp } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith, failReply } from "./cmd_mutation_helpers";
import { pickSessionInteractive, resolveSessionArg } from "./pick_session";
import { sessionLikes } from "./session_like";
import { displayName } from "./display_name";

export const cmdAssign = async (ctx: CommandContext, idOrUndefined: string | undefined, taskParts: string[]): Promise<void> => {
  // docs/03 grammar `assign [id] <task...>`: with no separator a single word
  // is the task (target picked via picker); two+ words → first is the id.
  let idArg: string | undefined;
  let taskArg: string[];
  if (idOrUndefined === undefined) {
    idArg = undefined;
    taskArg = taskParts;
  } else if (taskParts.length > 0) {
    idArg = idOrUndefined;
    taskArg = taskParts;
  } else {
    idArg = undefined;
    taskArg = [idOrUndefined];
  }
  const task = taskArg.join(" ");

  // 1) snapshot feeds both resolution paths (docs/03: list op reply)
  const listing = await listOp(ctx);
  if (!listing.ok) failReply(ctx, listing);
  const data = (listing.ok ? listing.result : {}) as {
    sessions?: Record<string, Record<string, unknown>>;
  };
  const sessions = data.sessions ?? {};

  let id: string;
  if (idArg !== undefined) {
    id = resolveSessionArg(ctx, sessionLikes(sessions, () => true), idArg);
  } else {
    const idle = sessionLikes(sessions, (rec) => rec.phase === "idle");
    if (idle.length === 0) return failWith(ctx, "not_found", "no idle sessions to assign");
    id = await pickSessionInteractive(ctx, idle, "assign");
  }

  // 2) cmd frame assign {id, task}
  const reply = await runOp(ctx, "assign", { id, task });
  if (!reply.ok) failReply(ctx, reply);

  // 3) output
  const name = displayName(id, sessions);
  const format = ctx.policy.format;
  if (format === "human") {
    emitResult(() => {
      ctx.io.stdout.write(`✓ assigned to ${name} — ${(task.split("\n")[0] ?? task)}\n`);
    });
    return;
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ assigned: true, id, sessionId: id, task }), format);
  });
};
