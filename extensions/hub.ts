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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveHubEnv } from "./hub_env";
import type { HubEnv } from "./hub_env";
import { createHubLocal } from "./hub_local";
import type { HubLocal } from "./hub_local";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
 * `runtimeFor` injects the AgentRuntime so tests pass fakes (no real omp). */
export const createHubCommands = (env: HubEnv, state: HubState, runtimeFor?: (local: HubLocal) => AgentRuntime, compose?: (env: HubEnv, state: HubState) => HubLocal) => ({
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
        // stop serving, keep the session running; open sessions are NOT
        // archived (docs/05 §Shutdown: they close individually via session_end)
        await state.local.stop();
        state.local = null;
        state.active = false;
        state.agentActive = false;
        state.agentName = null;
        return okMsg("hub stopped; session keeps running");
    },

    async hubAgent(): Promise<CommandOutcome> {
        if (!state.active || !state.local) return errMsg("hub not active — /hub-start first");
        if (state.agentActive) {
            // adopt the existing agent (docs/05 §Agent spawn: at most one)
            return okMsg("hub agent already running");
        }
        const spec = buildAgentSpec(env);
        if ("error" in spec) return errMsg(spec.error.message);
        const runtime = runtimeFor ? runtimeFor(state.local) : state.local.runtime;
        const spawned = await runtime.spawn({ name: spec.name, ...(env.model !== undefined ? { model: env.model } : {}) });
        if (!spawned.ok) return errMsg(spawned.error.message);
        state.agentActive = true;
        state.agentName = spawned.value.name;
        // agent row registered kind:"agent" via its own session_start frame;
        // attention isolation for it is the store's selfIds/guard-6 job
        return okMsg(`hub agent spawned as ${spawned.value.name}`);
    },

    stopAgent(): CommandOutcome {
        if (!state.agentActive || !state.agentName || !state.local) return errMsg("hub agent not running");
        const runtime = runtimeFor ? runtimeFor(state.local) : state.local.runtime;
        void runtime.kill(state.agentName);
        state.agentActive = false;
        state.agentName = null;
        return okMsg("hub agent stopped");
    },
});

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

export default function hub(pi: ExtensionAPI): void {
    const env = resolveHubEnv();

    // ---- brain guard (docs/05 §Anti-recursion guard 1) ----
    // The brain child loads this same extension with OMP_HUB_BRAIN=1. It must
    // contribute RPC answers only: return BEFORE any pi.on / registerTool /
    // registerCommand call. This early-return IS the first and hardest guard.
    if (env.brain) return;

    const state: HubState = {
        active: false,
        local: null,
        selfSessionId: "",
        agentActive: false,
        agentName: null,
    };
    const commands = createHubCommands(env, state);

    // Widget slot claimed up front (docs/05 §Entry step 1); the RENDER is
    // tk-z9a's — it consumes the subscription surface registered below and
    // paints through this same key. Cleared on /hub-stop and shutdown.
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        if (!state.active) ctx.ui.setWidget(WIDGET_KEY, ["hub idle — /hub-start to serve"]);
    });

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
            const out = state.agentActive ? commands.stopAgent() : await commands.hubAgent();
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
}
