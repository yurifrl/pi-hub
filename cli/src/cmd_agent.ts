// cli/src/cmd_agent.ts — `hub agent [--surface S]` (docs/03-cli.md §Subcommands
// agent): start the hub's own agent through the hub's supervised spawn path —
// cmd frame `agent {}` → the watcher's spawnAgent (docs/05 §Agent spawn: the
// one spawn every entry point resolves to; adopts a live child). The hub owns
// the child; this body owns the CLI-visible surface flag write.
//
// `--surface S`: writes `~/.hub/agents/<name>/surface.json` declaring the
// agentSurface id (docs/06 §agentSurface contract: the agent rewrites it
// later; this seeding write is the one CLI exception, made BEFORE the spawn
// so the child's first render already finds its declared surface). Atomic
// tmp+rename per docs/06; `revision` starts monotonic at 1.

import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSurfaceSeed } from "./agent_surface_types";
import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith, failReply } from "./cmd_mutation_helpers";
import { runOp } from "./hub_ops";
import { WATCHER_DEFAULTS } from "@yurifrl/hub/runtime/watcher";

/** The surfaces the CLI accepts (docs/06: bundled watcher + demo pending). */
const SURFACES: ReadonlySet<string> = new Set(["watcher", "pending"]);

export const cmdAgent = async (ctx: CommandContext, surface: string | undefined): Promise<void> => {
  const surfaceId = surface ?? "watcher";
  if (!SURFACES.has(surfaceId)) {
    return failWith(ctx, "usage", `agent: unknown surface ${surfaceId} (watcher | pending)`);
  }

  const reply = await runOp(ctx, "agent", {});
  if (!reply.ok) return failReply(ctx, reply);
  const result = reply.result as { name?: unknown };
  const name = typeof result.name === "string" && result.name ? result.name : WATCHER_DEFAULTS.name;

  // surface.json seeding write (docs/06 §Contract 3: atomic tmp+rename,
  // monotonic revision, capped content). watcher needs no file — the default
  // surface is renderable with zero writes (docs/06 §Decision).
  if (surfaceId !== "watcher") {
    const dir = join(ctx.config.dataRoot, "agents", name);
    const file = join(dir, "surface.json");
    const state: AgentSurfaceSeed = {
      agent: name,
      surface: surfaceId,
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      const handle = await open(tmp, "w");
      try {
        await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    } catch (e) {
      return failWith(ctx, "unavailable", `agent: surface.json write failed: ${(e as Error).message}`);
    }
  }

  const format = ctx.policy.format;
  if (format === "human") {
    return emitResult(() => {
      ctx.io.stdout.write(`✓ hub agent started (surface ${surfaceId})\n`);
      ctx.io.stdout.write(`  name ${name} — stop with hub kill ${name}\n`);
    });
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ started: true, name, surface: surfaceId }), format);
  });
};
