// extensions/hub_local.ts — the lib-side composition the extension drives at
// /hub-start (docs/05 §Entry step 2–4). Adapters are constructed here (json_store,
// jsonl_store, memory_bus, status attention store, timeout scheduler, omp_agent,
// unix_socket) and injected into the lib runtime (hub_core) and the watcher
// runtime (tk-jwx). The extension factory only calls start/stop and registers
// commands — no I/O decisions live in hub.ts itself.
//
// Env values arrive pre-resolved through HubEnv (extensions/hub_env.ts); nothing
// here reads process.env (docs/05 §Env vars: the extension boundary resolves).
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { createJsonStore } from "@yurifrl/hub/adapters/json_store";
import { createJsonlStore } from "@yurifrl/hub/adapters/jsonl_store";
import { createMemoryBus } from "@yurifrl/hub/adapters/memory_bus";
import { createStatusAttentionStore } from "@yurifrl/hub/adapters/attention_store";
import { createTimeoutScheduler } from "@yurifrl/hub/adapters/timeout_scheduler";
import { createOmpAgentRuntime } from "@yurifrl/hub/adapters/omp_agent";
import { startUnixSocketServer } from "@yurifrl/hub/adapters/unix_socket";
import type { HubSocketServer, ReportFrame } from "@yurifrl/hub/adapters/unix_socket";
import { startWatcher } from "@yurifrl/hub/runtime/watcher";
import type { WatcherRuntime } from "@yurifrl/hub/runtime/watcher";
import { createHubCore } from "@yurifrl/hub/runtime/hub_core";
import type { HubCore } from "@yurifrl/hub/runtime/hub_core";
import type { HubError, Result } from "@yurifrl/hub";
import type { StatusFile } from "@yurifrl/hub";
import type { RawOmpEvent } from "@yurifrl/hub";
import { join } from "node:path";
import type { HubEnv } from "./hub_env";

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Overridable edges for tests: fakes instead of real adapters (docs/01
 * §Testing: "extensions/hub.ts … no omp runtime needed"). */
export type HubLocalOverrides = {
    runtime?: HubCoreDepsRuntime;
    /** test hook replacing the real socket server factory */
    socket?: (opts: SocketOpts) => Pick<HubSocketServer, "start" | "close" | "broadcast" | "deliverTo">;
    /** test hook observing the watcher options (the watcher loop itself stays real) */
    watcher?: Parameters<typeof startWatcher>[0];
};

type SocketOpts = Parameters<typeof startUnixSocketServer>[0];
type HubCoreDepsRuntime = Parameters<typeof createHubCore>[0]["runtime"];

/** Which brain the local stack spawns (docs/05 §Entry step 3). */
export type BrainSpec = { name: string; bin: string; args: string[]; env: Record<string, string> };

export type HubLocalDeps = {
    env: HubEnv;
    /** the hub session's own session id; resolves "" until the first session_start */
    selfSessionId: () => string;
    overrides?: HubLocalOverrides;
};

/** Translate a docs/02 reporter frame into the RawOmpEvent the normalize
 * pipeline consumes. Unknown frame names are dropped (docs/05 §Error rules:
 * malformed/unknown frames are dropped silently). Pure. */
export const reportToRaw = (frame: ReportFrame): RawOmpEvent | null => {
    const p = frame as ReportFrame & Record<string, unknown>;
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (!sessionId) return null;
    switch (p.frame) {
        case "session_start":
            return {
                type: "session_start",
                sessionId,
                attached: p.attached === true,
                cwd: typeof p.cwd === "string" ? p.cwd : "",
            };
        case "user_message":
            return { type: "user_message", sessionId, text: typeof p.text === "string" ? p.text : "" };
        case "assistant_message":
            return { type: "assistant_message", sessionId, text: typeof p.text === "string" ? p.text : "" };
        case "tool_call":
            return { type: "tool_call", sessionId, tool: typeof p.tool === "string" ? p.tool : "unknown", args: p.args };
        case "agent_end":
            return typeof p.text === "string" && p.text.length > 0
                ? { type: "agent_end", sessionId, exitSummary: p.text }
                : { type: "agent_end", sessionId };
        default:
            return null;
    }
};

/** The running local stack. stop() is the /hub-stop body; start() the
 * /hub-start body. HubState in hub.ts mirrors this. */
export type HubLocal = {
    start(): Promise<Result<{ socketPath: string }, HubError>>;
    stop(): Promise<void>;
    /** publish the hub event stream to subscribed socket clients */
    broadcastEvent(evt: unknown): void;
    /** inbound reporter frame entry point (socket onReport → core.handleEvent) */
    handleReport(frame: ReportFrame): void;
    /** deliver a text into a peer session through the socket deliverTo bridge */
    deliverTo(sessionId: string, text: string): Result<void, HubError>;
    /** core + watcher + socket for tests/diagnostics */
    core: HubCore;
    /** the AgentRuntime driving brain/worker/agent children (agent toggle uses it) */
    runtime: Parameters<typeof createHubCore>[0]["runtime"];
    watcher: WatcherRuntime | null;
    socket: Pick<HubSocketServer, "start" | "close" | "broadcast" | "deliverTo"> | null;
    /** status.json update access for host concerns (hub meta row, agent rows) */
    updateStatus(mutate: (s: StatusFile) => StatusFile): Promise<Result<StatusFile, HubError>>;
    readStatus(): Promise<Result<StatusFile, HubError>>;
    /** the resolved brain spec the child is spawned with (diagnostics/tests) */
    brainSpec(): BrainSpec;
};

/** Compose the local hub stack. No I/O happens until start(). */
export const createHubLocal = (deps: HubLocalDeps): HubLocal => {
    const { env } = deps;
    const clock = { now: () => Date.now() };

    const status = createJsonStore(env.dataRoot);
    const summaries = createJsonlStore(env.dataRoot);
    const bus = createMemoryBus();
    const attention = createStatusAttentionStore({ status, summaries, clock, selfIds: () => [deps.selfSessionId()] });
    const scheduler = createTimeoutScheduler();
    const runtimeOpts = {
        bin: env.ompBin,
        ...(env.model !== undefined ? { model: env.model } : {}),
        flavor: "rpc" as const,
        extraEnv: {},
    };
    const runtime = deps.overrides?.runtime ?? createOmpAgentRuntime(runtimeOpts);

    const brainSpec = (): BrainSpec => {
        const spec: BrainSpec = { name: "brain", bin: env.ompBin, args: ["--mode", "rpc"], env: { OMP_HUB_BRAIN: "1" } };
        if (env.model !== undefined) spec.env.OMP_HUB_MODEL = env.model;
        return spec;
    };

    const core = createHubCore(
        {
            status,
            summaries,
            log: summaries,
            bus,
            runtime,
            attention,
            clock,
            selfSessionId: deps.selfSessionId,
            deliverTo: (sessionId, text) => socket?.deliverTo("plugin", sessionId, text) ?? { ok: false, error: { code: "unknown-session", message: "hub not serving", retryable: false } },
        },
        { ...(env.model !== undefined ? { model: env.model } : {}) },
    );

    let socket: Pick<HubSocketServer, "start" | "close" | "broadcast" | "deliverTo"> | null = null;
    let watcher: WatcherRuntime | null = null;

    const handleReport = (frame: ReportFrame): void => {
        const raw = reportToRaw(frame);
        if (!raw) return; // unknown/malformed frame: dropped silently (docs/05 §Error rules)
        void core.handleEvent(raw);
    };

    const socketFactory =
        deps.overrides?.socket ??
        ((opts: SocketOpts) =>
            startUnixSocketServer({
                ...opts,
                onReport: (frame) => {
                    opts.onReport?.(frame);
                },
            }));

    return {
        core,
        runtime,
        get watcher() {
            return watcher;
        },
        get socket() {
            return socket;
        },

        async start() {
            const dataRootPrepared = await prepareDataRoot(env.dataRoot);
            if (!dataRootPrepared.ok) return dataRootPrepared;

            // stale socket from a crashed hub is unlinked inside server.start()
            const built = socketFactory({
                socketPath: env.sock,
                hubInfo: { version: 1, startedAt: new Date(clock.now()).toISOString() },
                dispatch: async (req) => {
                    const reply = await core.surface.dispatch({ ...req, by: req.by ?? "cli" });
                    return reply.ok
                        ? { ok: true, result: reply.value }
                        : { ok: false, error: { code: reply.error.code, message: reply.error.message } };
                },
                onReport: (frame) => handleReport(frame),
            });
            socket = built;
            const started = await socket.start(env.sock);
            if (!started.ok) {
                socket = null;
                return started;
            }

            // watcher over the bus (tk-jwx runtime; spawn goes through AgentRuntime)
            const watcherOpts = deps.overrides?.watcher;
            watcher = startWatcher({
                runtime,
                bus,
                status,
                summaries,
                attention,
                clock,
                scheduler,
                env: { ompBin: env.ompBin, ...(env.model !== undefined ? { model: env.model } : {}) },
                ...(watcherOpts !== undefined ? { watcherOpts } : {}),
            } as Parameters<typeof startWatcher>[0]);

            // seed the meta block so reads never see a missing status.json
            // (docs/02 §Hub meta block); the skeleton version field leads
            const seeded = await status.update((s) => ({
                ...s,
                startedAt: new Date(clock.now()).toISOString(),
                pid: process.pid,
            }));
            if (!seeded.ok) return seeded;

            // spawn the brain child (docs/05 §Entry step 3): env OMP_HUB_BRAIN=1
            // (+ OMP_HUB_MODEL) via the omp_agent adapter; readiness = the
            // child's session_start frame landing through handleReport.
            const brain = brainSpec();
            const spawned = await core.spawnBrain(brain.name);
            if (!spawned.ok) return { ok: false, error: spawned.error };

            return ok({ socketPath: started.value.socketPath });
        },

        async stop() {
            watcher?.stop();
            watcher = null;
            await core.disposeChildren(); // brain + workers (docs/05 §Shutdown step 3)
            if (socket) {
                await socket.close(); // reporters see EOF, enter reconnect backoff
                socket = null;
            }
        },

        broadcastEvent(evt) {
            socket?.broadcast(evt);
        },

        handleReport,

        deliverTo(sessionId, text) {
            return socket?.deliverTo("plugin", sessionId, text) ?? { ok: false, error: { code: "unknown-session", message: "hub not serving", retryable: false } };
        },

        async updateStatus(mutate) {
            return status.update(mutate);
        },

        async readStatus() {
            return status.read();
        },

        brainSpec,
    };
};

const prepareDataRoot = async (dataRoot: string): Promise<Result<void, HubError>> => {
    try {
        await mkdir(dataRoot, { recursive: true });
        return ok(undefined);
    } catch (e) {
        return { ok: false, error: { code: "unavailable-hub", message: `cannot create data root ${dataRoot}: ${(e as Error).message}`, retryable: false } };
    }
};

export const HUB_DATA_ROOT_DEFAULT = join(homedir(), ".hub");
