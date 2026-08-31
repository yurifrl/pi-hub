// cli/src/cmd_spawn.ts — `hub spawn [--name N] [--model M]` (docs/03-cli.md
// §Subcommands): name omitted → hub picks worker-<n>; model omitted →
// config.spawnModel; human `✓ spawned <name> (model <M>)`; --json
// {name, model, sessionId}.

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { runOp } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failReply } from "./cmd_mutation_helpers";

export const cmdSpawn = async (ctx: CommandContext, opts: { name?: string; model?: string }): Promise<void> => {
  const model = opts.model !== undefined && opts.model.length > 0 ? opts.model : ctx.config.spawnModel;

  // cmd frame spawn {name?, model?} — hub picks worker-<n> when name omitted
  const args: Record<string, unknown> = {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(model.length > 0 ? { model } : {}),
  };
  const reply = await runOp(ctx, "spawn", args);
  if (!reply.ok) failReply(ctx, reply);

  const result = (reply.ok ? reply.result : {}) as { sessionId?: unknown; name?: unknown };
  const name = typeof result.name === "string" ? result.name : (opts.name ?? "");
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : "";

  if (ctx.policy.format === "human") {
    emitResult(() => {
      ctx.io.stdout.write(`✓ spawned ${name} (model ${model})\n`);
    });
    return;
  }
  const format = ctx.policy.format;
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ name, model, sessionId }), format);
  });
};
