// lib/runtime/hub_core.ts — the hub-side runtime the extension composes at
// /hub-start (docs/05 §Entry). Owns the event normalize pipeline (raw omp
// event → log line append + status.json mutation + bus publish) and the
// CommandSurface the unix_socket dispatch calls into. Lib layer: zero I/O of
// its own — stores, bus, runtime are injected ports; the env boundary
// (docs/05 §Env vars) lives entirely in extensions/hub.ts.
//
// Session registration (session_start frame → status.json row) happens HERE
// so every surface (widget, watcher, socket clients) sees one committed event
// stream. Self-feed (docs/05 §Anti-recursion guard 2) is the reporter's
// concern: the host calls handleEvent directly for its own frames.

import { hubError } from "../domain/command";
import type { HubError, OpName, CommandRequest, Result, Caller } from "../domain/command";
import type { LogEntry, RawOmpEvent, SessionRecord, StatusFile } from "../domain/session";
import type { StatusStore } from "../ports/status_store";
import type { SummaryStore } from "../ports/summary_store";
import type { EventBus } from "../ports/event_bus";
import type { AgentRuntime, AgentHandle } from "../ports/agent_runtime";
import type { AttentionStore } from "../ports/attention_store";
import type { Clock } from "../ports/clock";
import type { LogStore } from "../adapters/jsonl_store";

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Config resolved by the host extension boundary — hub_core never reads env. */
export type HubCoreConfig = {
    /** name of the hub's own worker process; default "brain" (docs/05 §Entry step 3) */
    brainName?: string;
    /** default model handed to spawned children when the caller did not pass one */
    model?: string;
};

export type HubCoreDeps = {
    status: StatusStore;
    summaries: SummaryStore;
    /** the LogStore half of jsonl_store — durable logs/<id>.jsonl appends */
    log: LogStore;
    bus: EventBus;
    runtime: AgentRuntime;
    /** AttentionStore over the same StatusStore; powers answer/dismiss */
    attention: AttentionStore;
    clock: Clock;
    /** the hub session's own session id (guard 3: no self-delivery); set by
     * the host once its first session_start has landed */
    selfSessionId: () => string;
    /** the socket→reporter deliver bridge: resolves when the reporter's
     * inbound `deliver` handler is registered (tk-epx); undefined until then
     * means "no reporter plumbed yet" and delivers fail unknown-session */
    deliverTo?: (sessionId: string, text: string) => Result<void, HubError>;
};

/** The hub-side runtime: event intake, command dispatch, child lifecycle. */
export type HubCore = {
    /** raw omp event in (reporter frame payload or self-feed): append log,
     * mutate status.json, publish on the bus. Errors are values. */
    handleEvent(raw: RawOmpEvent): Promise<Result<void, HubError>>;
    /** the CommandSurface served over hub.sock (docs/01 §Core abstractions) */
    surface: {
        dispatch(req: CommandRequest): Promise<Result<unknown, HubError>>;
        ops(): OpName[];
    };
    /** spawn the brain child (`omp --mode rpc` via the AgentRuntime port) */
    spawnBrain(name?: string): Promise<Result<AgentHandle, HubError>>;
    /** spawn a named worker (the `spawn` op's body) */
    spawnWorker(name?: string, model?: string): Promise<Result<AgentHandle, HubError>>;
    /** dispose every child this core spawned (SIGTERM → kill via runtime) */
    disposeChildren(): Promise<void>;
    /** live handles — diagnostics and tests */
    children(): AgentHandle[];
};

const iso = (clock: Clock): string => new Date(clock.now()).toISOString();

/** Render the one-line `text` per event kind (docs/05 §Reporter: "one rendered
 * line; no nested structures"; tool args best-effort, unserializable → ""). */
const renderText = (raw: RawOmpEvent): string => {
    switch (raw.type) {
        case "session_start":
            return raw.attached ? `attached ${raw.cwd}` : `session started in ${raw.cwd}`;
        case "user_message":
            return raw.text;
        case "assistant_message":
            return raw.text;
        case "tool_call": {
            try {
                return `${raw.tool} ${JSON.stringify(raw.args ?? "")}`;
            } catch {
                return raw.tool;
            }
        }
        case "agent_end":
            return raw.exitSummary ?? "";
    }
};

const LOG_KIND: Record<RawOmpEvent["type"], LogEventKindOf> = {
    session_start: "system",
    user_message: "prompt",
    assistant_message: "message",
    tool_call: "tool",
    agent_end: "system",
};
type LogEventKindOf = "prompt" | "tool" | "result" | "think" | "message" | "system";

/** Fresh SessionRecord for a session_start row (docs/02 §sessions map). */
const newSessionRecord = (raw: Extract<RawOmpEvent, { type: "session_start" }>, clock: Clock): SessionRecord => ({
    status: "open",
    kind: "peer",
    cwd: raw.cwd,
    title: raw.title ?? "",
    model: raw.model ?? "",
    phase: "working",
    log: `logs/${raw.sessionId}.jsonl`,
    toolCounts: {},
    turns: 0,
    startedAt: iso(clock),
    lastActivity: iso(clock),
});

/** Build the status.json mutation for one raw event. Pure: status in, next
 * status out. Single rewrite per event (docs/02 §Atomic rewrite). */
const applyEvent = (s: StatusFile, raw: RawOmpEvent, clock: Clock): StatusFile => {
    const at = iso(clock);
    const existing = s.sessions[raw.sessionId];
    if (!existing && raw.type !== "session_start") return s; // unknown session, no registration: ignore
    const base: SessionRecord = existing
        ? { ...existing, lastActivity: at }
        : newSessionRecord(raw as Extract<RawOmpEvent, { type: "session_start" }>, clock);
    let next: SessionRecord;
    switch (raw.type) {
        case "session_start":
            // attach idempotency (guard 4): upsert, never duplicate rows.
            // title/model arrive on the frame (docs/02 §Reporter frames:
            // session_start carries kind, cwd, model; docs/05 §Reporter: also
            // title) — passed through, never clobbering an existing title.
            next = {
                ...base,
                status: "open",
                ...(raw.title !== undefined && raw.title !== "" ? { title: raw.title } : {}),
                ...(raw.model !== undefined && raw.model !== "" ? { model: raw.model } : {}),
            };
            break;
        case "user_message":
            next = { ...base, turns: base.turns + 1, title: base.title || raw.text.slice(0, 80) };
            break;
        case "tool_call":
            next = { ...base, toolCounts: { ...base.toolCounts, [raw.tool]: (base.toolCounts[raw.tool] ?? 0) + 1 } };
            break;
        case "assistant_message":
        case "agent_end":
            next = base;
            break;
    }
    return { ...s, sessions: { ...s.sessions, [raw.sessionId]: next } };
};

/** Find a child handle by worker name or session id. */
const findChild = (children: Iterable<AgentHandle>, key: string): AgentHandle | undefined =>
    [...children].find((h) => h.name === key || h.sessionId === key);

export const createHubCore = (deps: HubCoreDeps, config: HubCoreConfig = {}): HubCore => {
    const children = new Map<string, AgentHandle>();

    const isSelf = (sessionId: string): boolean => sessionId !== "" && sessionId === deps.selfSessionId();

    const handleEvent = async (raw: RawOmpEvent): Promise<Result<void, HubError>> => {
        const text = renderText(raw);
        // 1. durable log line (docs/02 §logs)
        const logWrite = await deps.log.appendLog({
            t: iso(deps.clock),
            sessionId: raw.sessionId,
            kind: LOG_KIND[raw.type],
            text,
        });
        if (!logWrite.ok) return logWrite;
        // 2. status mutation (single atomic rewrite)
        const updated = await deps.status.update((s) => applyEvent(s, raw, deps.clock));
        if (!updated.ok) return updated;
        // 3. fan-out (docs/01 stage 4) — watcher + widget + socket subscribers
        const entry: LogEntry = {
            t: deps.clock.now(),
            sessionId: raw.sessionId,
            kind: raw.type,
            text: text.slice(0, 2048),
        };
        deps.bus.publish({ topic: "log", payload: entry });
        return ok(undefined);
    };

    /** Deliver text into a peer session. Workers get runtime.send (one NDJSON
     * line on the child's stdin); peer sessions go through the host-provided
     * socket→reporter bridge (tk-epx's reporter consumes the `deliver` frame). */
    const deliver = async (sessionId: string, text: string): Promise<Result<void, HubError>> => {
        if (isSelf(sessionId)) {
            return { ok: false, error: hubError("denied", "cannot deliver to the hub itself", { retryable: false }) };
        }
        const child = findChild(children.values(), sessionId);
        if (child) return deps.runtime.send(child.name, text);
        if (deps.deliverTo) {
            const res = deps.deliverTo(sessionId, text);
            if (res.ok) return res;
        }
        return { ok: false, error: hubError("unknown-session", `no live session ${sessionId}`, { retryable: false }) };
    };

    const spawnChild = async (name?: string, model?: string): Promise<Result<AgentHandle, HubError>> => {
        if (name !== undefined) {
            const dupe = findChild(children.values(), name);
            if (dupe && dupe.sessionId === null && children.has(name)) {
                return { ok: false, error: hubError("denied", `worker name already live: ${name}`, { retryable: false }) };
            }
        }
        const spawned = await deps.runtime.spawn({
            ...(name !== undefined ? { name } : {}),
            ...(model !== undefined ? { model } : {}),
        });
        if (!spawned.ok) return spawned;
        children.set(spawned.value.name, spawned.value);
        return spawned;
    };

    const dispatch = async (req: CommandRequest): Promise<Result<unknown, HubError>> => {
        const by: Caller = req.by;
        switch (req.op) {
            case "list": {
                const snap = await deps.status.read();
                if (!snap.ok) return snap;
                return ok({
                    hub: {
                        version: snap.value.version,
                        startedAt: snap.value.startedAt,
                        pid: snap.value.pid,
                        nextAttentionId: snap.value.nextAttentionId,
                    },
                    sessions: snap.value.sessions,
                    attention: snap.value.attention,
                    archived: snap.value.archived,
                });
            }
            case "send": {
                const target = typeof req.args.sessionId === "string" ? req.args.sessionId : typeof req.args.target === "string" ? req.args.target : "";
                const text = typeof req.args.text === "string" ? req.args.text : "";
                if (!target || !text) return { ok: false, error: hubError("unknown-session", "send needs sessionId and text", { retryable: false }) };
                const delivered = await deliver(target, text);
                return delivered.ok ? ok({ queued: true }) : delivered;
            }
            case "spawn": {
                const name = typeof req.args.name === "string" && req.args.name ? req.args.name : undefined;
                const model = typeof req.args.model === "string" && req.args.model ? req.args.model : config.model;
                const spawned = await spawnChild(name, model);
                if (!spawned.ok) return spawned;
                return ok({ sessionId: spawned.value.sessionId, name: spawned.value.name });
            }
            case "kill": {
                const key = typeof req.args.sessionId === "string" ? req.args.sessionId : typeof req.args.name === "string" ? req.args.name : "";
                const handle = findChild(children.values(), key);
                if (!handle) {
                    return { ok: false, error: hubError("unknown-session", `no live worker ${key}`, { retryable: false }) };
                }
                const killed = await deps.runtime.kill(handle.name);
                if (killed.ok) children.delete(handle.name);
                return killed.ok ? ok({ closedAt: iso(deps.clock) }) : killed;
            }
            case "attention": {
                const action = typeof req.args.action === "string" ? req.args.action : "list";
                const snap = await deps.status.read();
                if (!snap.ok) return snap;
                if (action === "list") {
                    return ok({ items: snap.value.attention.filter((i) => i.resolvedAt === undefined) });
                }
                if (action === "dismiss") {
                    const id = typeof req.args.id === "string" ? req.args.id : "";
                    const item = snap.value.attention.find((i) => i.id === id && i.resolvedAt === undefined);
                    if (!item) return { ok: false, error: hubError("unknown-session", `no open item ${id}`, { retryable: false }) };
                    const resolved = await deps.attention.resolve(id, undefined, by);
                    if (!resolved.ok) return resolved;
                    return ok({ item: resolved.value });
                }
                return { ok: false, error: hubError("denied", `unknown attention action ${action}`, { retryable: false }) };
            }
            case "answer": {
                const id = typeof req.args.id === "string" ? req.args.id : "";
                const text = typeof req.args.text === "string" ? req.args.text : "";
                const snap = await deps.status.read();
                if (!snap.ok) return snap;
                const item = snap.value.attention.find((i) => i.id === id && i.resolvedAt === undefined);
                if (!item) return { ok: false, error: hubError("unknown-session", `no open item ${id}`, { retryable: false }) };
                const delivered = await deliver(item.sessionId, text);
                if (!delivered.ok) return delivered;
                const resolved = await deps.attention.resolve(id, text, by);
                if (!resolved.ok) return resolved;
                return ok({ item: resolved.value });
            }
            case "assign": {
                const target = typeof req.args.sessionId === "string" ? req.args.sessionId : typeof req.args.id === "string" ? req.args.id : "";
                const task = typeof req.args.task === "string" ? req.args.task : "";
                if (!target || !task) return { ok: false, error: hubError("unknown-session", "assign needs sessionId and task", { retryable: false }) };
                const delivered = await deliver(target, task);
                if (!delivered.ok) return delivered;
                const updated = await deps.status.update((s) => ({
                    ...s,
                    sessions: Object.fromEntries(
                        Object.entries(s.sessions).map(([id, rec]) =>
                            id === target ? [id, { ...rec, phase: "working" as const, description: task.slice(0, 80) }] : [id, rec],
                        ),
                    ),
                }));
                if (!updated.ok) return updated;
                deps.bus.publish({ topic: "status", payload: { kind: "assign", sessionId: target, task } });
                return ok({ item: undefined });
            }
            case "tool":
            case "archive":
            case "logTail":
            case "summaries":
                return { ok: false, error: hubError("denied", `op ${req.op} not served by the plugin hub yet`, { retryable: false }) };
            default:
                return { ok: false, error: hubError("denied", "unknown op", { retryable: false }) };
        }
    };

    const surface = {
        dispatch,
        ops: (): OpName[] => ["list", "send", "tool", "spawn", "kill", "archive", "attention", "answer", "assign", "logTail", "summaries"],
    };

    return {
        handleEvent,
        surface,
        spawnBrain: async (name?: string) => spawnChild(name ?? config.brainName ?? "brain", config.model),
        spawnWorker: spawnChild,
        disposeChildren: async () => {
            for (const handle of [...children.values()]) {
                const killed = await deps.runtime.kill(handle.name);
                void killed;
            }
            children.clear();
        },
        children: () => [...children.values()],
    };
};
