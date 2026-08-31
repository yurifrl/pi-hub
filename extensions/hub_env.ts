// extensions/hub_env.ts — env resolution at the extension boundary (docs/05
// §Env vars). Host-layer only: lib never reads process.env; every value the
// lib side needs is resolved once here and injected. Testable against an
// injected env record — no process.env touching in tests.
import { homedir } from "node:os";
import { join } from "node:path";

/** Every env var the omp extension reads (docs/05 §Env vars table). */
export type HubEnv = {
    /** hub.sock path; default ~/.hub/hub.sock */
    sock: string;
    /** "1" → this process is a driven child (brain/worker); factory early-returns */
    brain: boolean;
    /** default model spec for spawned children; undefined when unset */
    model?: string;
    /** binary spawned for brain/worker/agent children; default "omp" */
    ompBin: string;
    /** "1" → this session IS the hub agent; frames kind:"agent", never the hub */
    hubAgent: boolean;
    /** data root (~/.hub); derived from the socket path's directory — status.json,
     * logs, summaries, archive all live beside the socket (docs/02 §Data root). */
    dataRoot: string;
};

const DEFAULT_SOCK = join(homedir(), ".hub", "hub.sock");

/** Resolve the hub env from an env record (defaults per docs/05). */
export const resolveHubEnv = (env: Record<string, string | undefined> = process.env): HubEnv => {
    const sock = env.OMP_HUB_SOCK && env.OMP_HUB_SOCK.length > 0 ? env.OMP_HUB_SOCK : DEFAULT_SOCK;
    const model = env.OMP_HUB_MODEL && env.OMP_HUB_MODEL.length > 0 ? env.OMP_HUB_MODEL : undefined;
    return {
        sock,
        brain: env.OMP_HUB_BRAIN === "1",
        ...(model !== undefined ? { model } : {}),
        ompBin: env.OMP_BIN && env.OMP_BIN.length > 0 ? env.OMP_BIN : "omp",
        hubAgent: env.OMP_HUB_AGENT === "1",
        dataRoot: sock.includes("/") ? sock.slice(0, sock.lastIndexOf("/")) : ".",
    };
};
