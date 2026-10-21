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
import type { LogEntry, RawOmpEvent, SessionRecord, StatusFile, ArchiveRecord } from "../domain/session";
import type { StatusStore } from "../ports/status_store";
import type { SummaryStore } from "../ports/summary_store";
import type { EventBus } from "../ports/event_bus";
import type { AgentRuntime, AgentHandle } from "../ports/agent_runtime";
import type { AttentionStore } from "../ports/attention_store";
import type { ArchiveStore } from "../ports/archive_store";
import type { Clock } from "../ports/clock";
import type { LogStore } from "../adapters/jsonl_store";

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

/** Config resolved by the host extension boundary — hub_core never reads env. */
export type HubCoreConfig = {
    /** name of the hub's own worker process; default "brain" (docs/05 §Entry step 3) */
    brainName?: string;
    /** default model handed to spawned children when the caller did not pass one */
    model?: string;
    /** hub-restart reaper grace (docs/02 §hub-restart): sessions with no event
     * since the hub's own start are closed+archived once this window passes;
     * default 60s */
    restartGraceMs?: number;
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
    /** ArchiveStore — the durable close-record writer (docs/02 §archive) */
    archive: ArchiveStore;
    clock: Clock;
    /** the hub session's own session id (guard 3: no self-delivery); set by
     * the host once its first session_start has landed */
    selfSessionId: () => string;
    /** the socket→reporter deliver bridge: resolves when the reporter's
     * inbound `deliver` handler is registered (tk-epx); undefined until then
     * means "no reporter plumbed yet" and delivers fail unknown-session */
    deliverTo?: (sessionId: string, text: string) => Result<void, HubError>;
    /** the supervised agent spawn (the `agent` op's body): the watcher's
     * spawnAgent, injected by hub_local — docs/05 §Agent spawn, one path
     * for CLI/web/plugin. Undefined → the op replies denied (hub built
     * without a watcher, tests). */
    spawnAgent?: () => Promise<Result<{ name: string }, HubError>>;
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
    /** hub-restart sweep (docs/02 §hub-restart): close+archive every live
     * session with no event since the hub's own start, once the grace window
     * passes; returns how many were reaped. Errors are values. */
    reapStale(): Promise<Result<number, HubError>>;
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

    const startedAtMs = deps.clock.now();
    const restartGraceMs = config.restartGraceMs ?? 60_000;

    /** Last agent summary text for a session, else its last description —
     * the finalSummary fallback chain (docs/02 §archive finalSummary). */
    const lastAgentSummary = async (id: string, rec: SessionRecord): Promise<string> => {
        const tail = await deps.summaries.tail(20, { id });
        if (tail.ok) {
            const last = [...tail.value].reverse().find((line) => line.kind === "summary");
            return last?.text ?? rec.description ?? "";
        }
        return rec.description ?? "";
    };

    /** Un-mark a "closing" row back to "open" — every failed close reverts so
     * a retry is possible (docs/02 §durability: closing must not strand). */
    const reopen = async (id: string): Promise<Result<void, HubError>> => {
        const done = await deps.status.update((s) => ({
            ...s,
            sessions: Object.fromEntries(Object.entries(s.sessions).map(([k, r]) => (k === id ? [k, { ...r, status: "open" as const }] : [k, r]))),
        }));
        return done.ok ? ok(undefined) : { ok: false, error: done.error };
    };

    /** The one close path every closer uses (docs/02 §kill row; durability
     * rule 2: status:"closing" → caller farewell → freeze → archive write →
     * one atomic rewrite dropping the row and appending the archived[]
     * tombstone, ordered after the archive file is durably on disk. A failed
     * step before the write re-opens the row; a crash between mark and write
     * leaves "closing" for the next start's reaper. A record already written
     * is never rewritten (ArchiveStore denies) — and the tombstone append
     * skips an existing same-path link so a concurrent close stays harmless. */
    const closeSession = async (id: string, closedBy: string, farewell?: () => Promise<Result<void, HubError>>): Promise<Result<{ record: ArchiveRecord; path: string }, HubError>> => {
        const closedAt = iso(deps.clock);
        const snap = await deps.status.read();
        if (!snap.ok) return { ok: false, error: snap.error };
        const rec = snap.value.sessions[id];
        if (!rec) return { ok: false, error: hubError("unknown-session", `no live session ${id}`, { retryable: false }) };
        if (rec.status === "closing") return { ok: false, error: hubError("denied", `session ${id} is already closing`, { retryable: false }) };

        const marked = await deps.status.update((s) => ({
            ...s,
            sessions: Object.fromEntries(Object.entries(s.sessions).map(([k, r]) => (k === id ? [k, { ...r, status: "closing" as const }] : [k, r]))),
        }));
        if (!marked.ok) return { ok: false, error: marked.error };

        if (farewell) {
            const said = await farewell();
            if (!said.ok) {
                const reverted = await reopen(id);
                if (!reverted.ok) return reverted;
                return said;
            }
        }

        // close-driven resolution (docs/02 §archive resolutions): the
        // session's still-open attention items resolve with the close so no
        // zombie item points at a dropped row; the re-read below then
        // harvests them into the record. Failed step before the write →
        // re-open, per the durability rule.
        const pre = await deps.status.read();
        if (!pre.ok) return { ok: false, error: pre.error };
        const stillOpen = pre.value.attention.filter((i) => i.sessionId === id && i.resolvedAt === undefined);
        const resolvedBy: Caller = closedBy === "cli" ? "cli" : "plugin";
        for (const item of stillOpen) {
            const resolved = await deps.attention.resolve(item.id, undefined, resolvedBy);
            if (!resolved.ok) {
                const reverted = await reopen(id);
                if (!reverted.ok) return reverted;
                return resolved;
            }
        }

        // re-read after the farewell: the close may flush one last event
        const after = await deps.status.read();
        if (!after.ok) return { ok: false, error: after.error };
        const frozen = after.value.sessions[id];
        if (!frozen) return { ok: false, error: hubError("unknown-session", `session ${id} closed by a concurrent closer`, { retryable: false }) };

        // every attention item resolved during the session's life, in resolve
        // order (docs/02 §archive resolutions) — status.attention[] keeps the
        // resolved rows, so the close harvests them from there
        const resolutions = after.value.attention
            .filter((i) => i.sessionId === id && i.resolvedAt !== undefined)
            .sort((a, b) => (a.resolvedAt! < b.resolvedAt! ? -1 : a.resolvedAt! > b.resolvedAt! ? 1 : 0));
        const record: ArchiveRecord = {
            ...frozen,
            id,
            closedAt,
            closedBy,
            finalSummary: await lastAgentSummary(id, frozen),
            version: after.value.version,
            ...(resolutions.length > 0 ? { resolutions } : {}),
        };
        const written = await deps.archive.write(record);
        if (!written.ok) {
            const reverted = await reopen(id);
            if (!reverted.ok) return reverted;
            return written;
        }
        const final = await deps.status.update((s) => ({
            ...s,
            sessions: Object.fromEntries(Object.entries(s.sessions).filter(([k]) => k !== id)),
            archived: [...s.archived.filter((a) => a.path !== written.value), { id, path: written.value, closedAt }].slice(-200),
        }));
        if (!final.ok) return { ok: false, error: final.error };
        deps.bus.publish({ topic: "status", payload: { kind: "archive", id, path: written.value } });
        return ok({ record, path: written.value });
    };

    /** hub-restart sweep (docs/02 §hub-restart): close+archive every live
     * session with no event since the hub's own start once the grace window
     * passes. Reporters announce on every start, so a still-running omp
     * session re-attaches first and keeps its row untouched. */
    const reapStale = async (): Promise<Result<number, HubError>> => {
        const cutoff = startedAtMs + restartGraceMs;
        const snap = await deps.status.read();
        if (!snap.ok) return { ok: false, error: snap.error };
        let reaped = 0;
        for (const [id, rec] of Object.entries(snap.value.sessions)) {
            const last = Date.parse(rec.lastActivity);
            if (Number.isNaN(last) || last >= cutoff || rec.status === "closing") continue;
            const closed = await closeSession(id, "hub-restart");
            if (closed.ok) reaped++;
        }
        return ok(reaped);
    };

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
                if (!key) return { ok: false, error: hubError("unknown-session", "kill needs sessionId (or worker name)", { retryable: false }) };
                const handle = findChild(children.values(), key);
                // spawned child with no session row yet (pre-announce): stop
                // the process; there is no session to mark or archive
                if (handle && !handle.sessionId) {
                    const killed = await deps.runtime.kill(handle.name);
                    if (killed.ok) children.delete(handle.name);
                    return killed.ok ? ok({ closedAt: iso(deps.clock) }) : killed;
                }
                // proper close (docs/02 §kill): mark closing → SIGTERM farewell
                // → archive write → tombstone; replies after it all complete
                const closed = await closeSession(handle?.sessionId ?? key, by, handle ? async () => deps.runtime.kill(handle.name) : undefined);
                if (!closed.ok) return closed;
                if (handle) children.delete(handle.name);
                return ok({ closedAt: closed.value.record.closedAt });
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
            case "agent": {
                // docs/05 §Agent spawn: the one spawn every entry point
                // resolves to — the watcher's supervised path (adopt when a
                // child is already live; env OMP_HUB_AGENT=1; kind:"agent").
                // surface: <id> is the CLI's concern (the surface.json write
                // contract is docs/06); the hub only spawns.
                if (!deps.spawnAgent) {
                    return { ok: false, error: hubError("denied", "agent spawn not available (no watcher wired)", { retryable: false }) };
                }
                const res = await deps.spawnAgent();
                if (!res.ok) return res;
                // docs/02 §ops table: reply { started: true, name }
                return ok({ started: true, name: res.value.name });
            }
            case "archive": {
                // docs/03 §archive: same close path as kill, no worker side
                // effects; reply { archived: true, id, path }
                const id = typeof req.args.sessionId === "string" ? req.args.sessionId : typeof req.args.id === "string" ? req.args.id : "";
                if (!id) return { ok: false, error: hubError("unknown-session", "archive needs sessionId", { retryable: false }) };
                const closed = await closeSession(id, "archive");
                if (!closed.ok) return closed;
                return ok({ archived: true, id, path: closed.value.path });
            }
            case "tool":
            case "logTail":
            case "summaries":
                return { ok: false, error: hubError("denied", `op ${req.op} not served by the plugin hub yet`, { retryable: false }) };
            case "ping":
                // liveness probe (docs/03 §Subcommands ping): a full dispatch
                // round-trip proves socket, parser, and core are alive. No state.
                return ok({ pong: true });
            default:
                return { ok: false, error: hubError("denied", "unknown op", { retryable: false }) };
        }
    };

    const surface = {
        dispatch,
        ops: (): OpName[] => ["list", "send", "tool", "spawn", "kill", "archive", "attention", "answer", "assign", "logTail", "summaries", "agent", "ping"],
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
        reapStale,
    };
};
