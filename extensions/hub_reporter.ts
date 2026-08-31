// extensions/hub_reporter.ts — the omp plugin's reporter (docs/05 §Reporter).
// One reporter instance per process: subscribes the host session events,
// translates them into docs/02 §Reporter frames, and ships them over hub.sock
// (ch:"report", fire-and-forget) — except the hub's own session, which is
// fed straight into the local hub handler (self-feed, docs/05 §Anti-recursion
// guard 2). All env values arrive pre-resolved via HubEnv; nothing here reads
// process.env (docs/05 §Env vars: the extension boundary resolves).
import type {
    ExtensionAPI,
    InputEvent,
    MessageEndEvent,
    SessionStartEvent,
    ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { connectHubClient } from "@yurifrl/hub/adapters/unix_socket";
import type { HubClient } from "@yurifrl/hub/adapters/unix_socket";
import type { HubEnv } from "./hub_env";

// ---- wire frames (docs/02-data-contracts.md §Reporter frames) ----
// Flat fields, exactly as the table defines; nothing invented.

/** { v, ch:"report", frame:"session_start", sessionId, kind, cwd, model, attached } */
export type SessionStartReportFrame = {
    frame: "session_start";
    sessionId: string;
    kind: "peer" | "self" | "worker" | "agent";
    cwd: string;
    model: string;
    attached: boolean;
    /** docs/05 §Reporter: session_start carries title */
    title?: string;
};

/** { v, ch:"report", frame:"user_message", sessionId, text } */
export type UserMessageReportFrame = { frame: "user_message"; sessionId: string; text: string };

/** { v, ch:"report", frame:"assistant_message", sessionId, text } */
export type AssistantMessageReportFrame = { frame: "assistant_message"; sessionId: string; text: string };

/** { v, ch:"report", frame:"tool_call", sessionId, tool, args } */
export type ToolCallReportFrame = { frame: "tool_call"; sessionId: string; tool: string; args: unknown };

/** { v, ch:"report", frame:"agent_end", sessionId, reason } */
export type AgentEndReportFrame = { frame: "agent_end"; sessionId: string; reason: "complete" | "interrupted" | "exit" };

/** Agent-enriched report payload: reporter-local facts (phase-relevant flags)
 * the hub records but the base frame table omits. Bounded, additive — readers
 * ignore unknown fields (docs/02 §Versioning). */
export type AgentReportExtras = { agent?: boolean };

// ---- connection state machine (docs/05 §Reporter: attach-on-connect) ----

type ReporterState =
    | { tag: "idle" } // not connected; no session facts yet
    | { tag: "connecting" } // socket attempt in flight
    | { tag: "live"; client: HubClient; session: { sessionId: string; title: string; cwd: string; model: string } };

/** Outbox cap (docs/05 §Reporter: bounded outbox, dropped wholesale above 50 on close). */
export const OUTBOX_MAX = 500;
export const OUTBOX_DROP_ABOVE = 50;
/** Reconnect backoff: 1s doubling to the 30s cap. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** Pure translation deps: the reporter's edges, all injected. */
export type ReporterOptions = {
    env: HubEnv;
    /** called on every real session_start to resolve sessionId/title/cwd/model
     * at the boundary (docs/05: hub_env.ts seam; zero process.env reads in lib) */
    sessionFacts(): { sessionId: string; title: string; cwd: string; model: string };
    /** the one inbound mutation of the host session: deliver → sendUserMessage
     * (docs/05 §Reporter: inbound frames handled by the reporter, exactly two) */
    sendUserMessage(text: string): void;
    /** true when this process is the hub agent (OMP_HUB_AGENT=1): frames are
     * marked kind:"agent" and excluded from attention/summarize loops */
    agent?: boolean;
    /** hub-local deps for the self-feed path (docs/05 §Reporter: bypasses the
     * socket when hubActive && sessionId === selfSessionId) */
    local: {
        isActive(): boolean;
        /** this session's own omp session id ("" until the first session_start) */
        selfSessionId(): string;
        /** the hub's event handler — the self-feed target (hub_local.handleReport) */
        handleReport(frame: unknown): void;
    };
    /** test hook replacing the real socket client factory */
    connect?: (sockPath: string) => Promise<{ ok: true; client: HubClient } | { ok: false; error: string }>;
};

/** TextContent from the text parts of an agent message (best-effort). The
 * AgentMessage union includes roles without text content (bashExecution, …);
 * those produce "". */
const textOf = (message: MessageEndEvent["message"]): string => {
    const parts: unknown = (message as { content?: unknown }).content;
    if (typeof parts === "string") return parts;
    if (!Array.isArray(parts)) return "";
    const text = (parts as unknown[])
        .filter((c): c is { type: "text"; text: string } => {
            const cc = c as { type?: unknown; text?: unknown } | null;
            return typeof cc === "object" && cc !== null && cc.type === "text" && typeof cc.text === "string";
        })
        .map((c) => c.text)
        .join("");
    return text;
};

/** Skill/command wrapper payloads are `<...>`-wrapped; skip them so injections
 * never pollute the log (docs/05 §Reporter: two capture paths contract). */
export const isWrapperBlock = (text: string): boolean => text.startsWith("<");

/** The two-capture-path dedup (docs/05 §Reporter, DECISION block): typed input
 * fires `input` and is authoritative; the user-role `message_end` of the SAME
 * turn is the fallback and must not double-report. `pending` only ever holds
 * an input awaiting its own message_end echo, so a delivered message (no
 * input) never poisons a later identical typed input. */
export const createSeenInputs = (): { onInput(text: string): void; onUserMessageEnd(text: string): boolean } => {
    let pending: string | null = null; // last typed input awaiting its message_end echo
    return {
        onInput(text) {
            pending = text;
        },
        onUserMessageEnd(text) {
            if (pending !== null && pending === text) {
                pending = null; // consumed: this turn already reported via input
                return false;
            }
            return true;
        },
    };
};

/** Tool args on the wire stay the raw value (docs/02 example: args is an
 * object). Best-effort guard: args that cannot survive JSON serialization
 * become "" so the frame itself never fails to serialize. */
export const safeArgs = (args: unknown): unknown => {
    try {
        JSON.stringify(args);
        return args;
    } catch {
        return "";
    }
};

/** map agent-loop end → docs/02 agent_end reason. */
const reasonOf = (messages: unknown): "complete" | "interrupted" | "exit" => {
    const last = Array.isArray(messages) ? (messages[messages.length - 1] as { stopReason?: string } | undefined) : undefined;
    return last?.stopReason === "aborted" ? "interrupted" : "complete";
};

/** Translate one omp event into its reporter frame (docs/05 §Reporter table).
 * Returns the frame for delivery (socket or self-feed), or null when the
 * event produces no frame (commands, wrapper blocks, deduped fallbacks).
 * Pure: facts + seen-state in, frame out. */
export const translateEvent = (
    event:
        | { type: "session_start"; event: SessionStartEvent }
        | { type: "input"; event: InputEvent }
        | { type: "message_end"; event: MessageEndEvent }
        | { type: "tool_execution_start"; event: ToolExecutionStartEvent }
        | { type: "agent_end"; event: { messages: unknown[] } }
        | { type: "session_shutdown" },
    ctx: {
        facts: { sessionId: string; title: string; cwd: string; model: string };
        seen: ReturnType<typeof createSeenInputs>;
    },
): (SessionStartReportFrame | UserMessageReportFrame | AssistantMessageReportFrame | ToolCallReportFrame | AgentEndReportFrame) | null => {
    switch (event.type) {
        case "session_start":
            // docs/05: real session start = attached:false (attach-on-connect
            // uses attached:true on every successful socket connect instead)
            return {
                frame: "session_start",
                sessionId: ctx.facts.sessionId,
                kind: "peer",
                cwd: ctx.facts.cwd,
                model: ctx.facts.model,
                attached: false,
                ...(ctx.facts.title !== "" ? { title: ctx.facts.title } : {}),
            };
        case "input": {
            const text = event.event.text;
            // commands are UI, not conversation (docs/05 §Reporter table)
            if (text.startsWith("/")) return null;
            ctx.seen.onInput(text); // awaiting this turn's message_end echo
            return { frame: "user_message", sessionId: ctx.facts.sessionId, text };
        }
        case "message_end": {
            const message = event.event.message as {
                role?: unknown;
                content?: unknown;
            } | null | undefined;
            if (!message || typeof message !== "object" || typeof message.role !== "string") return null;
            if (message.role === "assistant") {
                return {
                    frame: "assistant_message",
                    sessionId: ctx.facts.sessionId,
                    text: textOf(event.event.message),
                };
            }
            if (message.role === "user") {
                // fallback capture path (docs/05 DECISION: delivered/enqueued
                // prompts never pass through input); wrapper blocks skipped;
                // the typed-input echo of the same turn is deduped here
                const text = textOf(event.event.message);
                if (text === "" || isWrapperBlock(text)) return null;
                if (!ctx.seen.onUserMessageEnd(text)) return null;
                return { frame: "user_message", sessionId: ctx.facts.sessionId, text };
            }
            return null; // toolResult / other roles: no frame
        }
        case "tool_execution_start":
            return {
                frame: "tool_call",
                sessionId: ctx.facts.sessionId,
                tool: event.event.toolName,
                args: safeArgs(event.event.args),
            };
        case "agent_end":
            return {
                frame: "agent_end",
                sessionId: ctx.facts.sessionId,
                reason: reasonOf(event.event.messages),
            };
        case "session_shutdown":
            return {
                frame: "agent_end",
                sessionId: ctx.facts.sessionId,
                reason: "exit",
            };
    }
};

/** The reporter module: subscribes session events, emits reporter frames. */
export const createReporter = (opts: ReporterOptions) => {
    const seen = createSeenInputs();
    const agentExtras: AgentReportExtras = opts.agent === true ? { agent: true } : {};
    const connect = opts.connect ?? (async (sockPath: string) => {
        const res = await connectHubClient({ socketPath: sockPath, client: "plugin" });
        return res.ok ? { ok: true as const, client: res.value } : { ok: false as const, error: res.error.message };
    });

    let state: ReporterState = { tag: "idle" };
    let backoffMs = RECONNECT_BASE_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let connectedOnce = false;
    /** session facts from the most recent real session_start; the
     * attach-on-connect emission and every frame carry them verbatim */
    let facts: { sessionId: string; title: string; cwd: string; model: string } = { sessionId: "", title: "", cwd: "", model: "" };
    const outbox: Array<Record<string, unknown>> = [];

    const enqueue = (frame: Record<string, unknown>): void => {
        outbox.push({ v: 1, ch: "report", ...agentExtras, ...frame });
        if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
    };

    const isSelf = (): boolean =>
        opts.local.isActive() && facts.sessionId !== "" && facts.sessionId === opts.local.selfSessionId();

    const deliver = (frame: Record<string, unknown>): void => {
        // docs/05 §Anti-recursion guard 2: hubActive && sessionId ===
        // selfSessionId → handleEvent, never sendFrame. No socket round-trip,
        // no recursion risk; the hub watches itself exactly like a peer.
        if (isSelf()) {
            opts.local.handleReport(frame);
            return;
        }
        if (state.tag === "live") {
            const r = state.client.report(String(frame.frame), frame);
            if (r.ok) return;
            // write failed: drop into the outbox; reconnect re-announces
            enqueue(frame);
            return;
        }
        // not connected: keep the last frames so the attach is fresh
        enqueue(frame);
    };

    const attachFrame = (): Record<string, unknown> => ({
        v: 1,
        ch: "report",
        ...agentExtras,
        frame: "session_start",
        sessionId: facts.sessionId,
        kind: "peer",
        cwd: facts.cwd,
        model: facts.model,
        attached: true,
        ...(facts.title !== "" ? { title: facts.title } : {}),
    });

    /** Flush the outbox in order through a freshly-live client. Frames that
     * fail to write leave the rest queued; the cap is enforced in enqueue.
     * (docs/05 §Reporter: bounded outbox.) */
    const drainOutbox = (client: HubClient): void => {
        while (outbox.length > 0) {
            const frame = outbox[0]!;
            const r = client.report(String(frame.frame), frame);
            if (!r.ok) return; // socket died mid-drain: leave the rest queued
            outbox.shift();
        }
    };

    const scheduleReconnect = (delayMs: number): void => {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void open();
        }, delayMs);
    };

    const open = async (): Promise<void> => {
        if (stopped) return;
        if (state.tag !== "idle") return; // connecting or already live
        if (isSelf()) return; // self-feed: no socket for the hub's own session
        if (facts.sessionId === "") return; // no session identity yet
        state = { tag: "connecting" };
        const res = await connect(opts.env.sock);
        if (stopped) {
            if (res.ok) res.client.close({ reason: "restart", message: "reporter stopped" });
            return;
        }
        if (!res.ok) {
            state = { tag: "idle" };
            scheduleReconnect(backoffMs);
            backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
            return;
        }
        // success: backoff resets, the socket carries this session's frames
        backoffMs = RECONNECT_BASE_MS;
        state = { tag: "live", client: res.client, session: { ...facts } };
        res.client.onClose((info) => {
            // docs/05 §Reporter: bounded outbox, "dropped wholesale above 50
            // on close" — a flood queued behind a dead connection is stale
            // material, not worth replaying over the fresh attach frame.
            // Runs regardless of the current state tag: frames queued while
            // this connection was dying belong to ITS close, not the next's.
            if (outbox.length > OUTBOX_DROP_ABOVE) outbox.length = 0;
            if (state.tag !== "live" || state.client !== res.client) return;
            state = { tag: "idle" };
            if (stopped) return;
            // hub restart or socket death — reconnect with a fresh backoff;
            // attach-on-connect re-announces on success (idempotent upsert,
            // docs/05 §Anti-recursion guard 4). A deliberate session_shutdown
            // close arrives with stopped=true and never reaches here.
            void info;
            scheduleReconnect(RECONNECT_BASE_MS);
        });
        // attach-on-connect (docs/05 §Reporter): on EVERY successful connect
        // announce the running session FIRST — attached:true means "pickup of
        // an existing session"; the hub upserts by sessionId, so reconnects
        // and hub restarts are idempotent — no duplicate rows, no dup attention
        const af = attachFrame();
        const r = res.client.report("session_start", af);
        if (r.ok) {
            connectedOnce = true;
            drainOutbox(res.client); // the hub is listening: flush what queued
        } else {
            enqueue(af);
        }
    };

    // ---- host event subscription (docs/05 §Reporter table) ----

    const handleSessionStart = (event: SessionStartEvent): void => {
        facts = opts.sessionFacts();
        const frame = translateEvent({ type: "session_start", event }, { facts, seen });
        if (frame) deliver(frame as Record<string, unknown>);
        // first identity: the socket attempt can finally begin
        void open();
    };

    const handleInput = (event: InputEvent): void => {
        const frame = translateEvent({ type: "input", event }, { facts, seen });
        if (frame) deliver(frame as Record<string, unknown>);
    };

    const handleMessageEnd = (event: MessageEndEvent): void => {
        const frame = translateEvent({ type: "message_end", event }, { facts, seen });
        if (frame) deliver(frame as Record<string, unknown>);
    };

    const handleToolExecutionStart = (event: ToolExecutionStartEvent): void => {
        const frame = translateEvent({ type: "tool_execution_start", event }, { facts, seen });
        if (frame) deliver(frame as Record<string, unknown>);
    };

    const handleAgentEnd = (event: { messages: unknown[] }): void => {
        const frame = translateEvent({ type: "agent_end", event }, { facts, seen });
        if (frame) deliver(frame as Record<string, unknown>);
    };

    const handleSessionShutdown = (): void => {
        // best-effort farewell (docs/05 §Shutdown: reporter side) — the hub
        // closes THIS session properly (reason:"exit")
        const frame = translateEvent({ type: "session_shutdown" }, { facts, seen });
        if (frame) deliver(frame as Record<string, unknown>);
        stopped = true;
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (state.tag === "live") {
            const client = state.client;
            state = { tag: "idle" };
            client.close({ reason: "restart", message: "session shutdown" });
        }
    };

    return {
        /** wire the pi event handlers (called by the extension factory) */
        register(pi: ExtensionAPI): void {
            pi.on("session_start", (event) => handleSessionStart(event));
            pi.on("input", (event) => handleInput(event));
            pi.on("message_end", (event) => handleMessageEnd(event));
            pi.on("tool_execution_start", (event) => handleToolExecutionStart(event));
            pi.on("agent_end", (event) => handleAgentEnd(event));
            pi.on("session_shutdown", () => handleSessionShutdown());
        },
        /** test/low-level entry: drive the session_start path directly
         * (bypasses pi; the handlers are otherwise private closure state) */
        handleSessionStart(event: SessionStartEvent): void {
            handleSessionStart(event);
        },
        /** test/low-level entry: drive the input path directly */
        handleInput(event: InputEvent): void {
            handleInput(event);
        },
        /** test/low-level entry: fire the shutdown path directly */
        handleShutdown(): void {
            handleSessionShutdown();
        },
        /** current connection state (tests/diagnostics) */
        snapshot(): { state: string; sessionId: string; connectedOnce: boolean; outbox: number } {
            return { state: state.tag, sessionId: facts.sessionId, connectedOnce, outbox: outbox.length };
        },
        /** force a reconnect attempt now (tests) */
        tryConnect(): void {
            void open();
        },
        /** test access to the session facts the reporter currently carries */
        currentFacts(): { sessionId: string; title: string; cwd: string; model: string } {
            return { ...facts };
        },
        /** test access to the pending outbox frames (deepest reconnect storms) */
        peekOutbox(): Array<Record<string, unknown>> {
            return [...outbox];
        },
    };
};
