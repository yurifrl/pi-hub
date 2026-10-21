// cli/src/cmd_ping.ts — `hub ping` (docs/03-cli.md §Subcommands ping):
// side-effect-free liveness probe for scripts. One cmd/reply round-trip
// (op "ping") proves socket, parser, and dispatcher are alive — the same
// evidence bridge/run's manager needs (docs/07 §Run). Exit 0 live; missing
// socket / refused connect → unavailable-hub → exit 2; reply after the
// deadline → exit 3. Never mutates state; safe to retry in wait loops.

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { runOp } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failReply } from "./cmd_mutation_helpers";

export const cmdPing = async (ctx: CommandContext): Promise<void> => {
  const reply = await runOp(ctx, "ping", {});
  if (!reply.ok) failReply(ctx, reply);

  const format = ctx.policy.format;
  if (format === "human") {
    emitResult(() => {
      ctx.io.stdout.write("pong\n");
    });
    return;
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ pong: true }), format);
  });
};
