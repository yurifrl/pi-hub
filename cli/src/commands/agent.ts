// hub agent [--surface S] — start the hub agent and declare its surface (docs/06).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegisterCommand } from "../context";
import { emitSnapshot } from "../output";
import { painter } from "../paint";

const DEFAULT_SURFACE = "watcher";

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("agent")
    .description("start the hub agent")
    .option("--surface <id>", "surface id the agent renders to", DEFAULT_SURFACE)
    .action(async (opts: { surface: string }) => {
      const surface = opts.surface || DEFAULT_SURFACE;
      const reply = (await ctx.call("agent", {})) as { started?: boolean; name?: string } | undefined;
      const name = reply?.name ?? "";
      if (name) {
        const dir = join(ctx.config.dataRoot, "agents", name);
        mkdirSync(dir, { recursive: true });
        const body = { agent: name, surface, revision: 1, updatedAt: new Date().toISOString() };
        writeFileSync(join(dir, "surface.json"), `${JSON.stringify(body, null, 2)}\n`);
      }
      emitSnapshot(ctx.policy, { started: true, name, surface });
      if (ctx.policy.machine) return;
      process.stdout.write(`${painter(ctx.policy)("ok", "✓")} hub agent started (surface ${surface})\n`);
    });
};
