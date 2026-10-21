// hub serve — a standalone hub: binds the socket, serves ops, runs until signaled.
// Composes createHubLocal with serveBrain:false (no brain child, no widget, no omp session).

import { connectHubClient } from "@yurifrl/hub/adapters/unix_socket";
import { createHubLocal } from "../../../extensions/hub_local";
import { resolveHubEnv } from "../../../extensions/hub_env";
import type { RegisterCommand } from "../context";
import { CliError, fromHubError } from "../errors";

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("serve")
    .description("run a standalone hub on the socket until SIGINT/SIGTERM")
    .action(async () => {
      if (ctx.policy.machine) throw new CliError("usage", "serve has no --json/--ndjson mode: a server has no snapshot semantics");
      const { sock } = ctx.config;

      // The socket adapter unlinks a stale socket file before listening, which
      // would silently steal a LIVE hub's path — so probe with a handshake first.
      const probe = await connectHubClient({ socketPath: sock, client: "cli", deadlineMs: 1000 });
      if (probe.ok) {
        probe.value.close();
        throw new CliError("unavailable", `hub already live on ${sock}`);
      }

      const env = resolveHubEnv({ ...process.env, OMP_HUB_SOCK: sock });
      const local = createHubLocal({ env, selfSessionId: () => "", serveBrain: false });
      const started = await local.start();
      if (!started.ok) {
        await local.stop().catch(() => {});
        throw fromHubError(started.error);
      }
      process.stdout.write(`hub serving on ${started.value.socketPath}\n`);

      const stopped = Promise.withResolvers<void>();
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
      const stop = (): void => {
        for (const sig of signals) process.off(sig, stop);
        void local.stop().then(stopped.resolve, stopped.resolve);
      };
      for (const sig of signals) process.on(sig, stop);
      await stopped.promise;
    });
};
