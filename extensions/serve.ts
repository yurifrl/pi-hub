// extensions/serve.ts — standalone hub composition entry (docs/07 §Run).
// Same stack createHubLocal builds (socket, stores, core, watcher), but no
// brain child and no omp session: the socket, stores, and ops need no omp.
// bridge/run starts this before the Hermes container; /hub-start remains the
// omp-embedded alternative (docs/05 §Entry).
//
// Reads process.env once at the host boundary (resolveHubEnv); the lib side
// never touches process.env (docs/01 §Ports). Runs until SIGINT/SIGTERM,
// exits 0 — stopping a server is not an error (docs/03 §Signals).
import { resolveHubEnv } from "./hub_env";
import { createHubLocal } from "./hub_local";

export const serveHub = async (envRecord: Record<string, string | undefined> = process.env): Promise<void> => {
    const env = resolveHubEnv(envRecord);
    const local = createHubLocal({
        env,
        selfSessionId: () => "", // no embedded omp session to name
        serveBrain: false,
    });
    const started = await local.start();
    if (!started.ok) {
        process.stderr.write(`hub serve: ${started.error.message}\n`);
        process.exitCode = 1;
        return;
    }

    process.stdout.write(`hub serving on ${started.value.socketPath}\n`);
    const stopped = Promise.withResolvers<void>();
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const stop = (): void => {
        for (const sig of signals) process.off(sig, stop);
        void local.stop().then(stopped.resolve);
    };
    for (const sig of signals) process.on(sig, stop);
    await stopped.promise;
    process.exitCode = 0;
};
