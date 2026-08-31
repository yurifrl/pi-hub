// extensions/hub.ts — the omp extension entry (docs/05 §Entry). Thin driving
// adapter over @yurifrl/hub: registers the three commands, claims the widget
// key, and drives the lib-side composition (extensions/hub_local.ts). All env
// resolution happens here at the boundary (docs/05 §Env vars) — lib never
// reads process.env. One default export; all state lives in the closure.
//
// Anti-recursion (docs/05 §Anti-recursion): the brain guard early-returns
// before ANY registration; /hub-start inside the hub agent is refused (guard
// 5); the self-feed guard (2) lives in the reporter seam this file exposes
// via selfSessionId + handleLocalFrame (tk-epx consumes them).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveHubEnv } from "./hub_env";
import type { HubEnv } from "./hub_env";
import { createHubLocal } from "./hub_local";
import type { HubLocal } from "./hub_local";
import { createHubTools } from "./hub_tools";
import { createReporter } from "./hub_reporter";
import type { AgentRuntime } from "@yurifrl/hub";

/** The widget key — the stable contract with omp's UI (docs/05 §Widget).
 * tk-z9a renders into this slot; cleared on /hub-stop and shutdown. */
export const WIDGET_KEY = "omp-hub-stream";

/** Mutable hub state inside the factory closure (docs/05 §Entry: "all state
 * lives inside the factory closure"). */
type HubState = {
    active: boolean;
    local: HubLocal | null;
    /** this session's own omp session id ("" until the first session_start) */
    selfSessionId: string;
    /** agent toggle state (docs/05 §Agent spawn: at most one hub agent) */
    agentActive: boolean;
    /** the agent child handle name from the runtime */
    agentName: string | null;
};

const okMsg = (text: string): { ok: true; text: string } => ({ ok: true, text });
const errMsg = (text: string): { ok: false; text: string } => ({ ok: false, text });

export type CommandOutcome = { ok: boolean; text: string };

/** Pure command bodies over injected state — exported for tests (docs/01
 * §Testing: extensions exercised with a stubbed host context).
 * `agentRuntimeFor` injects the acp AgentRuntime so tests pass fakes (no real
 * omp); defaults to the local stack's acp runtime. */
export const createHubCommands = (env: HubEnv, state: HubState, agentRuntimeFor?: (local: HubLocal) => AgentRuntime, compose?: (env: HubEnv, state: HubState) => HubLocal) => {
    /** Kill the agent child through the acp runtime and reset toggle state.
     * Returns false when no agent is running. */
    const killAgent = async (): Promise<boolean> => {
        if (!state.agentActive || !state.agentName || !state.local) return false;
        const runtime = agentRuntimeFor ? agentRuntimeFor(state.local) : state.local.agentRuntimeFor();
        await runtime.kill(state.agentName);
        state.agentActive = false;
        state.agentName = null;
        return true;
    };

    return {
        async hubStart(): Promise<CommandOutcome> {
            if (state.active) return errMsg("hub already active");
            if (env.hubAgent) {
                // guard 5: the hub agent may not become the hub (docs/05 §Anti-recursion)
                return errMsg("this session is the hub agent");
            }
            const local = compose ? compose(env, state) : createHubLocal({ env, selfSessionId: () => state.selfSessionId });
            const started = await local.start();
            if (!started.ok) return errMsg(started.error.message);
            state.local = local;
            state.active = true;
            return okMsg(`hub serving on ${started.value.socketPath}`);
        },

        async hubStop(): Promise<CommandOutcome> {
            if (!state.active || !state.local) return errMsg("hub not active");
            // kill the agent child first (spawned outside core.children — the
            // watcher's spawn; leaving it alive would orphan it and let a
            // following /hub-agent double-spawn, violating "at most one")
            await killAgent();
            // stop serving, keep the session running; open sessions are NOT
            // archived (docs/05 §Shutdown: they close individually via session_end)
            await state.local.stop();
            state.local = null;
            state.active = false;
            return okMsg("hub stopped; session keeps running");
        },

        async hubAgent(): Promise<CommandOutcome> {
            if (!state.active || !state.local) return errMsg("hub not active — /hub-start first");
            // guard 5 precheck + the docs/06 spawn spec (acp peer, env
            // OMP_HUB_AGENT=1) — the same spec every entry point resolves to.
            const spec = buildAgentSpec(env);
            if ("error" in spec) return errMsg(spec.error.message);
            if (state.agentActive) {
                // adopt the existing agent (docs/05 §Agent spawn: at most one;
                // /hub-agent adopts the one that is already alive)
                return okMsg("hub agent already running");
            }
            // the spawn itself goes through the watcher's supervised path so
            // agentSession lands in status.json and supervision is live
            // (docs/06: three entry points, one path)
            const spawn = state.local.watcherSpawn();
            if (!spawn) return errMsg("hub not active — /hub-start first");
            const spawned = await spawn;
            if (!spawned.ok) return errMsg(spawned.error.message);
            state.agentActive = true;
            state.agentName = spawned.value.name;
            // agent row registered kind:"agent" via its own session_start frame;
            // attention isolation for it is the watcher's selfIds/guard-6 job
            return okMsg(`hub agent spawned as ${spawned.value.name}`);
        },
    };
};

/** Agent spawn spec (docs/05 §Agent spawn + docs/06 §Hub agent): omp --mode
 * acp child, env OMP_HUB_AGENT=1 (+ OMP_HUB_MODEL), bin from OMP_BIN. */
export const buildAgentSpec = (env: HubEnv): { name: string; bin: string; args: string[]; env: Record<string, string> } | { error: { code: string; message: string } } => {
    if (env.hubAgent) {
        return { error: { code: "denied", message: "this session is the hub agent" } };
    }
    const childEnv: Record<string, string> = { OMP_HUB_AGENT: "1" };
    if (env.model !== undefined) childEnv.OMP_HUB_MODEL = env.model;
    return { name: "hub-watcher", bin: env.ompBin, args: ["--mode", "acp"], env: childEnv };
};

/** The extension body, parameterized for tests (docs/01 §Testing: injectable
 * edges). `connect` replaces the real hub.sock client factory so order tests
 * run hermetically; production callers use the default export. */
export const createHubExtension = (injections?: { connect?: Parameters<typeof createReporter>[0]["connect"] }) => (pi: ExtensionAPI): void => {
    const env = resolveHubEnv();

    // ---- brain guard (docs/05 §Anti-recursion guard 1) ----
    // The brain child loads this same extension with OMP_HUB_BRAIN=1. It must
    // contribute RPC answers only: return BEFORE any pi.on / registerTool /
    // registerCommand call. This early-return IS the first and hardest guard.
    if (env.brain) return;

    /** The most recent ExtensionContext — the session-identity source for the
     * reporter (sessionId/title/cwd/model live here, not in events). */
    let lastCtx: ExtensionContext | undefined;

    const state: HubState = {
        active: false,
        local: null,
        selfSessionId: "",
        agentActive: false,
        agentName: null,
    };
    const commands = createHubCommands(env, state);

    // ---- the nine hub_* tools (docs/05 §Tools) — registered in every
    // non-brain session; each call resolves its route at call time:
    // hub-local via state, peer relay over hub.sock via env.sock. ----
    for (const tool of createHubTools({ env, state })) {
        pi.registerTool(tool);
    }

    // ---- reporter (docs/05 §Reporter) ----
    // One reporter instance per process. It owns the event→frame translation,
    // the reconnecting socket with attach-on-connect, and the self-feed
    // decision: hubActive && sessionId === selfSessionId → the local hub
    // handler directly, never the socket (docs/05 §Anti-recursion guard 2).
    // Everything it needs is resolved HERE at the boundary (hub_env.ts seam).
    const reporter = createReporter({
        env,
        agent: env.hubAgent,
        local: {
            isActive: () => state.active,
            selfSessionId: () => state.selfSessionId,
            // the hub's own frames enter the pipeline exactly like a peer's:
            // reportToRaw + core.handleEvent (tk-hai seam)
            handleReport: (frame) => state.local?.handleReport(frame as never),
        },
        // session identity resolved at the boundary (docs/01: hosts parse,
        // lib decides). The session manager's id is the omp session id.
        sessionFacts: () => {
            const ctx = lastCtx;
            return {
                sessionId: ctx?.sessionManager.getSessionId() ?? "",
                title: ctx?.sessionManager.getSessionName() ?? "",
                cwd: ctx?.cwd ?? process.cwd(),
                model: ctx?.model?.id ?? "",
            };
        },
        // the reporter's one inbound mutation of the host session (docs/05
        // §Reporter: inbound frames handled by the reporter, exactly two —
        // deliver resolves here; reply wires arrive with the tk-sj9 cmd client)
        sendUserMessage: (text) => {
            // sendUserMessage lives on the ExtensionAPI; the API surface does
            // not need a ctx — fire and walk away, never throws into the host
            try {
                pi.sendUserMessage(text);
            } catch {
                /* host session gone; the hub already got the write result */
            }
        },
        ...(injections?.connect ? { connect: injections.connect } : {}),
    });

    // ---- session_start: ctx capture BEFORE the reporter (tk-epx P0) ----
    // pi dispatches same-extension handlers in REGISTRATION ORDER with ONE
    // shared ExtensionContext, and SessionStartEvent carries no sessionId —
    // identity is only reachable via ctx. This handler must therefore run
    // BEFORE the reporter's session_start handler (registered by
    // reporter.register below), or the first session_start of every real
    // process resolves sessionFacts against an undefined lastCtx: sessionId
    // "", no connect, dead frames.
    // It also claims the widget slot (docs/05 §Entry step 1); the RENDER is
    // tk-z9a's — it consumes the subscription surface registered below and
    // paints through this same key. Cleared on /hub-stop and shutdown. The
    // two concerns are independent; pi supports multiple listeners.
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        lastCtx = ctx;
        if (!state.active) ctx.ui.setWidget(WIDGET_KEY, ["hub idle — /hub-start to serve"]);
    });

    reporter.register(pi);

    // ---- /hub-start ----
    pi.registerCommand("hub-start", {
        description: "Make this session the hub: serve hub.sock, spawn the brain, register the widget",
        handler: async (_args, ctx) => {
            const out = await commands.hubStart();
            if (!out.ok) {
                ctx.ui.notify(out.text, "error");
                return;
            }
            // claim the widget slot with an orientation line; tk-z9a replaces
            // the renderer and keeps the key stable across renders
            ctx.ui.setWidget(WIDGET_KEY, ["hub active — watching sessions"]);
            ctx.ui.notify(out.text, "info");
        },
    });

    // ---- /hub-stop ----
    pi.registerCommand("hub-stop", {
        description: "Stop serving the hub; keep the session running (open sessions stay open)",
        handler: async (_args, ctx) => {
            const out = await commands.hubStop();
            if (!out.ok) {
                ctx.ui.notify(out.text, "error");
                return;
            }
            ctx.ui.setWidget(WIDGET_KEY, ["hub idle — /hub-start to serve"]);
            ctx.ui.notify(out.text, "info");
        },
    });

    // ---- /hub-agent ----
    pi.registerCommand("hub-agent", {
        description: "Toggle the hub agent (spawn omp --mode acp child, watcher surface)",
        handler: async (_args, ctx) => {
            const out = await commands.hubAgent();
            ctx.ui.notify(out.text, out.ok ? "info" : "error");
        },
    });

    // ---- shutdown (docs/05 §Shutdown): widget cleared, socket closed, children
    // disposed, status updated — peer sessions are left as-is (never archived). ----
    pi.on("session_shutdown", () => {
        const clear = (ctx?: ExtensionContext) => {
            if (ctx) ctx.ui.setWidget(WIDGET_KEY, undefined);
        };
        if (state.active) {
            void commands.hubStop().then(() => clear());
        } else {
            clear();
        }
    });
};

/** The omp entry point (docs/05 §Entry): production factory, no injections. */
export default function hub(pi: ExtensionAPI): void {
    createHubExtension()(pi);
}
