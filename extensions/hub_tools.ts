// extensions/hub_tools.ts — the nine hub_* tools (docs/05-omp-plugin.md §Tools).
// Every non-brain session registers them; each tool picks its route at call
// time: hub-local when this session IS the hub (selfSessionId seam from
// tk-hai), peer relay over hub.sock otherwise (docs/05 §Tools dispatch rule).
//
// Tool errors are values, never throws (docs/05 §Tools › Error rules): a dead
// target, a hub fault, or a timeout resolves {ok:false, text} — a reporting
// session must survive hub death and the hub must survive a dead peer.
// Single-writer rule (docs/05 §Error rules): tools only ever call the hub's
// command surface or speak frames; they never write hub files.

import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { TSchema, Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Result, HubError, AttentionItem, SessionRecord } from "@yurifrl/hub";
import { connectHubClient } from "@yurifrl/hub/adapters/unix_socket";
import type { HubClient } from "@yurifrl/hub/adapters/unix_socket";
import type { HubEnv } from "./hub_env";

// ---- shared hub state (structural mirror of the tk-hai factory closure) ------
// Mirrors extensions/hub.ts's closure state without importing it (import would
// pull the module side effects; the shape is the contract, docs/01 §Testing).

export type HubStateLike = {
    active: boolean;
    selfSessionId: string;
    local: {
        core: {
            surface: {
                dispatch(req: { cmdId: string; op: string; args: Record<string, unknown>; by: "plugin" | "cli" | "web" | "agent" }): Promise<Result<unknown, HubError>>;
            };
        };
    } | null;
};

export type HubToolsDeps = {
    env: HubEnv;
    /** shared mutable hub state (the hub.ts factory closure, mirrored structurally) */
    state: HubStateLike;
    /** injectable hub.sock client factory for tests (defaults to the real adapter) */
    connect?: (env: HubEnv) => Promise<Result<HubClient, HubError>>;
};

// ---- tool result shape ------------------------------------------------------

/** Content block of a tool result (pi-ai TextContent). */
type TextBlock = { type: "text"; text: string };

type HubToolResult = AgentToolResult<Record<string, unknown>> & { isError?: boolean };

const textBlock = (text: string): TextBlock => ({ type: "text", text });

const okResult = (text: string, details: Record<string, unknown> = {}): HubToolResult => ({
    content: [textBlock(text)],
    isError: false,
    details,
});

const errResult = (text: string, details: Record<string, unknown> = {}): HubToolResult => ({
    content: [textBlock(text)],
    isError: true,
    details,
});

// ---- routing decision (docs/05 §Tools: hub-local vs peer relay) --------------

/** True when this session IS the hub: hub-local route (docs/05 §Tools). */
export const isHubLocal = (deps: HubToolsDeps): boolean =>
    deps.state.active && deps.state.selfSessionId !== "" && deps.state.local !== null;

// ---- schema validation (bad args → tool error result, never a throw) ---------

/** Validate raw tool args against a TypeBox schema; error text on failure. */
export const validateArgs = <S extends TSchema>(
    schema: S,
    args: unknown,
): { ok: true; value: Static<S> } | { ok: false; error: string } => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { ok: false, error: "arguments must be a JSON object" };
    }
    if (!Check(schema, args)) {
        const errs = Errors(schema, args);
        const detail = errs.length > 0 ? errs.map((e) => e.message).join("; ") : "invalid arguments";
        return { ok: false, error: `invalid arguments: ${detail}` };
    }
    return { ok: true, value: args as Static<S> };
};

// ---- result normalization (docs/05 §Tools: Results flatten to tool-result) ----

/** Flatten a relay/local Result into display text + details. */
export const normalizeRelayResult = (op: string, res: Result<unknown, HubError>): { text: string; details: Record<string, unknown> } => {
    if (!res.ok) {
        return { text: `hub ${op} failed: ${res.error.message} (code: ${res.error.code})`, details: { op, error: res.error } };
    }
    return { text: normalizeValueResult(op, res.value), details: { op, result: res.value } };
};

/** Render one op's reply value as the tool's text payload (per-op renderers). */
export const normalizeValueResult = (op: string, value: unknown): string => {
    switch (op) {
        case "list": {
            const snap = value as { hub?: { pid?: number; startedAt?: string }; sessions?: Record<string, SessionRecord>; attention?: AttentionItem[] };
            const sessions = snap.sessions ?? {};
            const attention = snap.attention ?? [];
            const ids = Object.keys(sessions);
            const hub = snap.hub ?? {};
            const lines = [
                `hub pid ${hub.pid ?? "?"} started ${hub.startedAt ?? "?"} — ${ids.length} session(s), ${attention.length} open attention item(s)`,
                ...ids.map((id) => {
                    const s = sessions[id]!;
                    return `${id} [${s.kind}] ${s.title || "(untitled)"} — ${s.phase} — ${s.description ?? "no description"} — last activity ${s.lastActivity}`;
                }),
                ...attention.map((a) => `attention ${a.id} (${a.kind}) session ${a.sessionId}: ${a.text}`),
            ];
            return lines.join("\n");
        }
        case "spawn": {
            const v = value as { sessionId?: string | null; name?: string };
            return `worker spawned: ${v.name ?? "?"} (session ${v.sessionId ?? "pending announce"})`;
        }
        case "kill": {
            const v = value as { closedAt?: string };
            return `worker killed at ${v.closedAt ?? "unknown time"}; archive record written`;
        }
        case "attention": {
            const v = value as { items?: AttentionItem[] };
            const items = v.items ?? [];
            if (items.length === 0) return "0 open attention items — nothing needs you";
            return items.map((a) => `attention ${a.id} (${a.kind}) session ${a.sessionId}: ${a.text}`).join("\n");
        }
        default:
            return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }
};

// ---- per-tool timeouts (docs/05 §Tools Routing lines) -------------------------

export const TOOL_TIMEOUTS = {
    hub_list_sessions: 10_000,
    hub_send_message: (waitSeconds: number): number => Math.max(waitSeconds * 1000 + 15_000, 30_000),
    hub_call_tool: (waitSeconds: number): number => waitSeconds * 1000 + 30_000,
    hub_spawn_worker: 60_000,
    hub_kill_worker: 15_000,
    hub_archive: 15_000,
    hub_attention: 10_000,
    hub_answer: 15_000,
    hub_assign: 15_000,
} as const;

// ---- schemas (docs/05 §Tools per-tool parameter sketches) ----------------------

const TTarget = Type.String({ description: "worker name, session id prefix, or title substring" });
const TWaitSeconds = Type.Optional(
    Type.Integer({ minimum: 0, maximum: 600, description: "seconds to wait for the target's response; default 0" }),
);

export const TOOL_SCHEMAS = {
    hub_list_sessions: Type.Object({}),
    hub_send_message: Type.Object({
        target: TTarget,
        message: Type.String({ description: "text delivered into the target session as a user message" }),
        wait_seconds: TWaitSeconds,
    }),
    hub_call_tool: Type.Object({
        target: TTarget,
        tool: Type.String({ description: "tool name, e.g. bash, read, write" }),
        args: Type.Optional(Type.String({ description: 'tool arguments as JSON, e.g. {"command":"ls"}' })),
        wait_seconds: TWaitSeconds,
    }),
    hub_spawn_worker: Type.Object({
        name: Type.Optional(Type.String({ description: "worker name (default worker-N)" })),
        model: Type.Optional(Type.String({ description: "model spec for the worker" })),
    }),
    hub_kill_worker: Type.Object({
        name: Type.String({ description: "worker name" }),
    }),
    hub_archive: Type.Object({
        id: Type.String({ description: "session id prefix or title substring" }),
    }),
    hub_attention: Type.Object({}),
    hub_answer: Type.Object({
        id: Type.String({ description: "attention item id" }),
        text: Type.String({ description: "answer delivered to the session" }),
    }),
    hub_assign: Type.Object({
        id: Type.String({ description: "session id prefix or title substring" }),
        task: Type.String({ description: "task text delivered to the session" }),
    }),
} as const;

export type HubToolName = keyof typeof TOOL_SCHEMAS;

// ---- op arg builders (tool args → docs/02 §Ops request payload) ----------------

/** Per-tool op + arg mapping (docs/05 §Tools → docs/02 §Ops). Exposed for the
 * routing-matrix tests: the same tool must map to the same op either route. */
export const TOOL_OPS: Record<HubToolName, { op: string; args: (params: Record<string, unknown>) => Record<string, unknown>; timeout: (params: Record<string, unknown>) => number }> = {
    hub_list_sessions: {
        op: "list",
        args: () => ({}),
        timeout: () => TOOL_TIMEOUTS.hub_list_sessions,
    },
    hub_send_message: {
        op: "send",
        args: (p) => ({ sessionId: p.target, text: p.message, ...(typeof p.wait_seconds === "number" && p.wait_seconds > 0 ? { waitMs: p.wait_seconds * 1000 } : {}) }),
        timeout: (p) => TOOL_TIMEOUTS.hub_send_message(typeof p.wait_seconds === "number" ? p.wait_seconds : 0),
    },
    hub_call_tool: {
        op: "tool",
        // docs/02 §Ops: tool request is { sessionId, tool, args } with args as
        // a JSON object. wait_seconds does NOT travel on the wire — it bounds
        // the tool-side await only; the hub paces the op itself (30s deadline,
        // 120s when queued behind a busy target).
        args: (p) => ({
            sessionId: p.target,
            tool: p.tool,
            ...(p.args !== undefined ? { args: p.args } : {}),
        }),
        timeout: (p) => TOOL_TIMEOUTS.hub_call_tool(typeof p.wait_seconds === "number" ? p.wait_seconds : 240),
    },
    hub_spawn_worker: {
        op: "spawn",
        args: (p) => ({ ...(typeof p.name === "string" && p.name.length > 0 ? { name: p.name } : {}), ...(typeof p.model === "string" && p.model.length > 0 ? { model: p.model } : {}) }),
        timeout: () => TOOL_TIMEOUTS.hub_spawn_worker,
    },
    hub_kill_worker: {
        op: "kill",
        args: (p) => ({ sessionId: p.name }),
        timeout: () => TOOL_TIMEOUTS.hub_kill_worker,
    },
    hub_archive: {
        op: "archive",
        args: (p) => ({ sessionId: p.id }),
        timeout: () => TOOL_TIMEOUTS.hub_archive,
    },
    hub_attention: {
        op: "attention",
        args: () => ({ action: "list" }),
        timeout: () => TOOL_TIMEOUTS.hub_attention,
    },
    hub_answer: {
        op: "answer",
        args: (p) => ({ id: p.id, text: p.text }),
        timeout: () => TOOL_TIMEOUTS.hub_answer,
    },
    hub_assign: {
        op: "assign",
        args: (p) => ({ sessionId: p.id, task: p.task }),
        timeout: () => TOOL_TIMEOUTS.hub_assign,
    },
};

// ---- tool bodies ---------------------------------------------------------------

export type ToolBody = (args: Record<string, unknown>, deps: HubToolsDeps) => Promise<HubToolResult>;

/** Wrap a body with schema validation + error envelope (docs/05 §Tools › Error
 * rules: bad args are a tool error result, not a throw into the host session). */
const withSchema = (name: HubToolName, body: ToolBody): ToolBody => async (args, deps) => {
    const checked = validateArgs(TOOL_SCHEMAS[name], args);
    if (!checked.ok) return errResult(`hub tool ${name}: ${checked.error}`, { tool: name });
    try {
        return await body(checked.value as Record<string, unknown>, deps);
    } catch (e) {
        // body blew up — still a tool error result, never a throw (docs/05 §Error rules)
        return errResult(`hub tool ${name} failed: ${(e as Error).message}`, { tool: name });
    }
};

/** One routed op call: hub-local surface or peer relay, normalized either way.
 * Peer relay: cmd frame over hub.sock, correlated reply, per-tool timeout. */
export const routeOp = async (name: HubToolName, params: Record<string, unknown>, deps: HubToolsDeps): Promise<HubToolResult> => {
    const spec = TOOL_OPS[name];
    const args = spec.args(params);
    const timeoutMs = spec.timeout(params);
    if (isHubLocal(deps)) {
        const local = deps.state.local!;
        const res = await local.core.surface.dispatch({
            cmdId: `tool-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
            op: spec.op,
            args,
            by: "plugin",
        });
        const { text, details } = normalizeRelayResult(spec.op, res);
        return res.ok ? okResult(text, details) : errResult(text, details);
    }
    const connected = deps.connect
        ? await deps.connect(deps.env)
        : await connectHubClient({ socketPath: deps.env.sock, client: "plugin", deadlineMs: timeoutMs });
    if (!connected.ok) {
        return errResult(`hub unreachable at ${deps.env.sock}: ${connected.error.message} — is the hub running (hub serve or /hub-start)?`, {
            op: spec.op,
            error: connected.error,
        });
    }
    const client = connected.value;
    try {
        const res = await client.cmd(spec.op, args, timeoutMs);
        const { text, details } = normalizeRelayResult(spec.op, res);
        return res.ok ? okResult(text, details) : errResult(text, details);
    } finally {
        client.close();
    }
};

const BODIES: Record<HubToolName, ToolBody> = {
    hub_list_sessions: async (_args, deps) => routeOp("hub_list_sessions", {}, deps),
    hub_send_message: async (args, deps) => routeOp("hub_send_message", args as Record<string, unknown>, deps),
    hub_call_tool: async (args, deps) => {
        const params = args as { args?: string };
        // docs/05 schema: args is a JSON string — parse it once here so the op
        // payload carries the object (docs/02 §Ops: tool request { sessionId,
        // tool, args }); invalid JSON → tool error before any frame leaves
        if (typeof params.args === "string" && params.args.length > 0) {
            try {
                (params as { args: unknown }).args = JSON.parse(params.args);
            } catch (e) {
                return errResult(`hub_call_tool: args is not valid JSON: ${(e as Error).message}`, { tool: "hub_call_tool" });
            }
        }
        return routeOp("hub_call_tool", params, deps);
    },
    hub_spawn_worker: async (args, deps) => routeOp("hub_spawn_worker", args as Record<string, unknown>, deps),
    hub_kill_worker: async (args, deps) => routeOp("hub_kill_worker", args as Record<string, unknown>, deps),
    hub_archive: async (args, deps) => routeOp("hub_archive", args as Record<string, unknown>, deps),
    hub_attention: async (_args, deps) => routeOp("hub_attention", {}, deps),
    hub_answer: async (args, deps) => routeOp("hub_answer", args as Record<string, unknown>, deps),
    hub_assign: async (args, deps) => routeOp("hub_assign", args as Record<string, unknown>, deps),
};

export const TOOL_BODIES: Record<HubToolName, ToolBody> = Object.fromEntries(
    (Object.keys(BODIES) as HubToolName[]).map((name) => [name, withSchema(name, BODIES[name])]),
) as Record<HubToolName, ToolBody>;

// ---- registered descriptions (docs/05 §Tools, verbatim) -------------------------

export const TOOL_DESCRIPTIONS: Record<HubToolName, string> = {
    hub_list_sessions:
        "List all live OMP sessions on the hub plus its RPC workers. Requires the hub to be active (hub serve or /hub-start in the hub terminal).",
    hub_send_message:
        "Send a message into another live OMP session via the hub. The target's agent receives it as a user message. Set wait_seconds to also return its reply.",
    hub_call_tool:
        "Make another OMP session (or RPC worker) call a tool and report the result. For workers this is a direct round-trip returning the actual result.",
    hub_spawn_worker:
        "Spawn a fresh headless OMP session (omp --mode rpc) managed by the hub. Drive it with hub_send_message / hub_call_tool.",
    hub_kill_worker:
        "Dispose an RPC worker spawned by hub_spawn_worker. Kills the process and writes the archive record.",
    hub_archive:
        "Properly close a live session: flush state, write the archive record (closedAt, closedBy, finalSummary) and remove it from status.json.",
    hub_attention:
        "List the hub's open attention items (approval, question, blocked, idle) with ids, sessions, and text. Empty result means nothing needs you.",
    hub_answer:
        "Answer an attention item: deliver the text to its session, resolve the item, and record the resolution.",
    hub_assign:
        "Give an idle session work: deliver the task text as a user message and mark the session working.",
};

// ---- registration (docs/05 §Tools: pi.registerTool; TypeBox parameter schema) ----

export const HUB_TOOL_NAMES: readonly HubToolName[] = [
    "hub_list_sessions",
    "hub_send_message",
    "hub_call_tool",
    "hub_spawn_worker",
    "hub_kill_worker",
    "hub_archive",
    "hub_attention",
    "hub_answer",
    "hub_assign",
] as const;

/** The nine registered tool definitions, wired to the shared state closure. */
export const createHubTools = (deps: HubToolsDeps): ToolDefinition[] =>
    HUB_TOOL_NAMES.map((name) => ({
        name,
        label: name,
        description: TOOL_DESCRIPTIONS[name],
        parameters: TOOL_SCHEMAS[name],
        // params arrive host-validated against the same schema we re-check in
        // withSchema (defense in depth: bad args → error result, never a throw);
        // signal/onUpdate/ctx unused — hub ops carry their own per-tool timeout
        execute: async (_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown): Promise<HubToolResult> =>
            TOOL_BODIES[name](params as Record<string, unknown>, deps),
    }));

/** Run one registered tool by name — tests + diagnostics entry. */
export const runHubTool = async (name: HubToolName, args: unknown, deps: HubToolsDeps): Promise<HubToolResult> =>
    TOOL_BODIES[name](args as Record<string, unknown>, deps);
