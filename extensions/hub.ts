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
import { createWidgetController } from "./widget";
import type { WidgetController, WidgetHost } from "./widget";
import { createTimeoutScheduler } from "@yurifrl/hub/adapters/timeout_scheduler";
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
    /** the 8-line attention widget controller (docs/05 §Widget) */
    widget: WidgetController | null;
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

/** The widget factory the default entry uses. Default wires the real
 * hub.sock subscription + timeout scheduler (no module-level mutable state). */
const defaultWidgetFactory = (host: WidgetHost, env: HubEnv): WidgetController =>
    createWidgetController({
        sockPath: env.sock,
        host,
        scheduler: createTimeoutScheduler(),
    });

export default function hub(pi: ExtensionAPI): void {
    const env = resolveHubEnv();

    // ---- brain guard (docs/05 §Anti-recursion guard 1) ----    // The brain child loads this same extension with OMP_HUB_BRAIN=1. It must
    // contribute RPC answers only: return BEFORE any pi.on / registerTool /
    // registerCommand call. This early-return IS the first and hardest guard.
    if (env.brain) return;

    const state: HubState = {
        active: false,
        local: null,
        selfSessionId: "",
        agentActive: false,
        agentName: null,
        widget: null,
    };
    const commands = createHubCommands(env, state);

    // ---- widget lifecycle (docs/05 §Widget) ----
    // The controller owns the attention model, the 250 ms debounce, and the
    // paint through WIDGET_KEY. Events reach it two ways: the hub.sock
    // subscription (own + peer frames mirror through the hub) and the
    // in-process EventBus tap (hub-local events, CLI-op mutations). Started
    // on /hub-start, stopped on /hub-stop and shutdown (widget cleared).
    let widgetBusUnsub: (() => void) | null = null;
    const startWidget = (widgetHost: WidgetHost): WidgetController => {
        const controller = defaultWidgetFactory(widgetHost, env);
        controller.start();
        // in-process tap: local.stack events land without a socket round trip
        widgetBusUnsub = state.local?.subscribeWidget((evt) => {
            const e = evt as { topic?: string; payload?: Record<string, unknown> };
            if (typeof e?.topic !== "string") return;
            controller.handleEvent({ kind: e.topic, ...(e.payload ?? {}) });
        }) ?? null;
        return controller;
    };
    const stopWidget = (ctx?: ExtensionContext): void => {
        widgetBusUnsub?.();
        widgetBusUnsub = null;
        state.widget?.stop(); // stop() clears the widget slot itself
        state.widget = null;
        if (ctx) ctx.ui.setWidget(WIDGET_KEY, undefined);
    };

    // Widget slot claimed up front (docs/05 §Entry step 1); the RENDER is
    // tk-z9a's — the controller below paints through this same key once the
    // hub starts. Cleared on /hub-stop and shutdown.
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
            // claim the widget slot with an orientation line, then hand the
            // slot to the controller: it subscribes to hub.sock and paints
            // the 8-line attention render under the same key
            ctx.ui.setWidget(WIDGET_KEY, ["hub active — watching sessions"]);
            state.widget = startWidget({ setWidget: (lines) => ctx.ui.setWidget(WIDGET_KEY, lines) });
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
            stopWidget(ctx);
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
            stopWidget(ctx);
            if (ctx) ctx.ui.setWidget(WIDGET_KEY, undefined);
        };
        if (state.active) {
            void commands.hubStop().then(() => clear());
        } else {
            clear();
        }
    });
}
