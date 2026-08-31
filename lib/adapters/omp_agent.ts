// lib/adapters/omp_agent.ts — AgentRuntime port over spawned omp child processes
// (docs/05-omp-plugin.md §Agent spawn). Port implementation; all I/O; imports
// ports + domain (docs/01-architecture.md §Package layout).
//
// One runtime instance per child flavor, composed by the root (hub_local):
//  - hub runtime (default rpc): brain/workers — `OMP_BIN --mode rpc`, env OMP_HUB_BRAIN=1 (+ OMP_HUB_MODEL)
//  - agent runtime (acp): the hub agent — `OMP_BIN --mode acp`, env OMP_HUB_AGENT=1
//
// env resolution (OMP_BIN, OMP_HUB_MODEL, the binary path) belongs to the host
// — constructors take explicit values, adapters never read process.env
// (acceptance #1). Errors are values; nothing throws across the port boundary.

import { spawn } from "node:child_process";
import { hubError } from "../domain/command";
import type { HubError, Result } from "../domain/command";
import type { AgentHandle, AgentRuntime } from "../ports/agent_runtime";

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Child flavor — which driven mode omp runs in (docs/05 §Agent spawn). */
export type AgentFlavor = "rpc" | "acp";

export type OmpAgentOptions = {
    /** binary to spawn (e.g. "/usr/local/bin/omp"); resolved by the host */
    bin: string;
    /** extra args prepended before `--mode` (e.g. ["-c", script] to run a
     * command instead of a script file; launching freshly written script
     * files is avoided because macOS Gatekeeper assessment can silently
     * block their exec) */
    args?: string[];
    /** default model spec handed to children without an explicit one */
    model?: string;
    /** child mode: "rpc" for brain/worker, "acp" for the hub agent */
    flavor?: AgentFlavor;
    /** working directory for the child (defaults to process cwd) */
    cwd?: string;
    /** extra env merged over process.env for the child (host-resolved values) */
    extraEnv?: Record<string, string>;
    /** ms to wait after SIGTERM before SIGKILL (docs/05 §Shutdown: "SIGTERM, then kill after grace") */
    killGraceMs?: number;
};

/** AgentRuntime over real omp subprocesses. `spawn` starts the child and
 * resolves once the process is alive; `send` writes one NDJSON line to its
 * stdin; `kill` does SIGTERM → grace → SIGKILL. The child announces its
 * sessionId itself (reporter `session_start` / RPC handshake) — the hub
 * observes it via the event feed, so `AgentHandle.sessionId` starts null and
 * is updated by the host when the announcement lands. */
export const createOmpAgentRuntime = (opts: OmpAgentOptions): AgentRuntime => {
    const flavor: AgentFlavor = opts.flavor ?? "rpc";
    const killGraceMs = opts.killGraceMs ?? 5000;
    const children = new Map<string, { proc: ReturnType<typeof spawn>; handle: AgentHandle }>();

    const spawnChild = async (spec: { name?: string; model?: string }): Promise<Result<AgentHandle, HubError>> => {
        const name = spec.name ?? `worker-${children.size + 1}`;
        const model = spec.model ?? opts.model;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...(opts.extraEnv ?? {}),
            ...(model !== undefined ? { OMP_HUB_MODEL: model } : {}),
            ...(flavor === "rpc" ? { OMP_HUB_BRAIN: "1" } : { OMP_HUB_AGENT: "1" }),
        };
        try {
            const proc = spawn(opts.bin, [...(opts.args ?? []), "--mode", flavor], {
                env,
                cwd: opts.cwd,
                stdio: ["pipe", "pipe", "pipe"],
            });
            const handle: AgentHandle = { name, sessionId: null, ...(model !== undefined ? { model } : {}) };
            children.set(name, { proc, handle });
            proc.once("error", (e: Error) => {
                // spawn failure (ENOENT etc.) — mark dead; the send/kill paths report it
                children.delete(name);
                void e;
            });
            proc.once("exit", () => {
                children.delete(name);
            });
            // a spawn of an existing binary does not fail synchronously; ENOENT
            // surfaces as the async `error` event, so treat "still alive after
            // the next tick" as spawned. Cheap liveness check for the common
            // ENOENT case without waiting for output.
            await new Promise<void>((resolve) => {
                if (proc.pid !== undefined) return resolve();
                proc.once("error", () => resolve());
                setTimeout(resolve, 250);
            });
            if (proc.pid === undefined) {
                return { ok: false, error: hubError("unavailable-hub", `failed to spawn ${opts.bin} --mode ${flavor}`, { retryable: false }) };
            }
            return ok(handle);
        } catch (e) {
            return { ok: false, error: hubError("unavailable-hub", `spawn failed: ${(e as Error).message}`, { retryable: false, cause: e }) };
        }
    };

    const send = async (name: string, text: string): Promise<Result<void, HubError>> => {
        const child = children.get(name);
        if (!child || child.proc.pid === undefined || child.proc.stdin === null) {
            return { ok: false, error: hubError("unknown-session", `no live child named ${name}`, { retryable: false }) };
        }
        try {
            child.proc.stdin.write(JSON.stringify({ text }) + "\n");
            return ok(undefined);
        } catch (e) {
            return { ok: false, error: hubError("unavailable-hub", `write to ${name} failed: ${(e as Error).message}`, { retryable: true, cause: e }) };
        }
    };

    const kill = async (name: string): Promise<Result<void, HubError>> => {
        const child = children.get(name);
        if (!child) {
            return { ok: false, error: hubError("unknown-session", `no live child named ${name}`, { retryable: false }) };
        }
        children.delete(name);
        const { proc } = child;
        if (proc.pid !== undefined) {
            proc.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    if (proc.pid !== undefined) proc.kill("SIGKILL");
                    resolve();
                }, killGraceMs);
                proc.once("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        return ok(undefined);
    };

    return { spawn: spawnChild, send, kill };
};
