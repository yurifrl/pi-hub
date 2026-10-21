// hub spawn [--name N] [--model M] — start a worker session under the hub.

import type { RegisterCommand } from "../context";
import { emitSnapshot } from "../output";
import { painter } from "../paint";

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("spawn")
    .description("spawn a worker session")
    .option("--name <name>", "worker name")
    .option("--model <model>", "model id (default: config spawnModel)")
    .action(async (opts: { name?: string; model?: string }) => {
      const model = opts.model || ctx.config.spawnModel || undefined;
      const args: Record<string, unknown> = {
        ...(opts.name ? { name: opts.name } : {}),
        ...(model ? { model } : {}),
      };
      const reply = (await ctx.call("spawn", args)) as { name?: string; sessionId?: string } | undefined;
      const name = reply?.name ?? opts.name ?? "";
      emitSnapshot(ctx.policy, {
        name,
        ...(model ? { model } : {}),
        ...(reply?.sessionId !== undefined ? { sessionId: reply.sessionId } : {}),
      });
      if (ctx.policy.machine) return;
      const paint = painter(ctx.policy);
      process.stdout.write(`${paint("ok", "✓")} spawned ${name}${model ? ` (model ${model})` : ""}\n`);
    });
};
