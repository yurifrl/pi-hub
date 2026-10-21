// hub ping — side-effect-free liveness probe: exit 0 live, 2 dead (spec §Subcommands → ping).

import type { RegisterCommand } from "../context";
import { emitSnapshot } from "../output";

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("ping")
    .description("liveness probe (exit 0 live / 2 dead)")
    .action(async () => {
      const result = await ctx.call("ping");
      emitSnapshot(ctx.policy, result ?? { ok: true });
      if (!ctx.policy.machine) process.stdout.write("hub: live\n");
    });
};
