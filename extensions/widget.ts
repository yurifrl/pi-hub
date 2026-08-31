// extensions/widget.ts — the 8-line attention widget (docs/05 §Widget).
// Rendering the attention contract, not the raw stream: hard budget of 8
// lines, renderer clips, never wraps. Pure pieces (model fold, hue math,
// line composition) live here; hub.ts drives the controller with a stubbed
// host ui in tests.
//
// Layout (docs/05 §Widget line budget):
//   1      orientation: `⚠ n ⏳ n 💤 n` + top attention item + answer hint
//   2–6    up to five session rows: hue bar + short id/title + phase glyph + description
//   7      overflow (`+N more sessions` / `+N more attention items`) or newest summary (flash)
//   8      footer: OMP_HUB_SOCK path + `summaries <n>`
//
// Data source: the hub.sock subscription (hub_sock.ts) folded into a local
// attention model. Degrade: hub offline → static `(hub offline)` state, no
// crash, reconnect with bounded backoff. NO_COLOR → plain text. Hue comes
// from the shared lib hash (lib/theme.ts) — never re-hashed here.
import { hueColorCodes, type AttentionItem, type Phase, type SummaryLine } from "@yurifrl/hub";
import type { Scheduler } from "@yurifrl/hub/ports/scheduler";
import { subscribeHubFeed, type HubFeedHandle } from "./hub_sock";

// ---- widget model (the local attention state, folded from event frames) ----

/** One session row in the widget. */
export type WidgetSession = {
    id: string;
    /** display title: session title, falling back to a short id slice */
    name: string;
    phase: Phase;
    description: string;
    /** epoch ms of the last frame touching this session (recency order) */
    lastActivity: number;
};

/** Complete widget state — everything the renderer needs. */
export type WidgetModel = {
    sessions: Record<string, WidgetSession>;
    /** open attention items, newest first (as raised) */
    attention: AttentionItem[];
    /** total summaries seen (footer count) */
    summaryCount: number;
    /** newest summary line, shown on line 7 (summary-flash) */
    lastSummary: SummaryLine | null;
};

export const emptyWidgetModel = (): WidgetModel => ({
    sessions: {},
    attention: [],
    summaryCount: 0,
    lastSummary: null,
});

/** A decoded hub event frame (docs/02 §Event frames) — the five reporter
 * frame names carry their payloads flat; attention wraps under `item`. */
export type WidgetFrame =
    | { kind: "session_start"; sessionId: string; attached: boolean; cwd: string; title?: string }
    | { kind: "user_message"; sessionId: string; text: string }
    | { kind: "assistant_message"; sessionId: string; text: string }
    | { kind: "tool_call"; sessionId: string; tool: string }
    | { kind: "agent_end"; sessionId: string }
    | { kind: "attention"; item: AttentionItem }
    | { kind: "summary"; line: SummaryLine }
    | { kind: "phase"; sessionId: string; phase: Phase }
    | { kind: "status"; kindData?: unknown };

/** Decode one raw ch:"event" frame into a WidgetFrame; unknown kinds and
 * malformed frames are dropped (null) per docs/05 §Error rules. */
export const decodeFrame = (f: Record<string, unknown>): WidgetFrame | null => {
    const kind = f.kind;
    if (typeof kind !== "string") return null;
    switch (kind) {
        case "session_start":
            return typeof f.sessionId === "string" && f.sessionId !== ""
                ? {
                      kind,
                      sessionId: f.sessionId,
                      attached: f.attached === true,
                      cwd: typeof f.cwd === "string" ? f.cwd : "",
                      ...(typeof f.title === "string" && f.title !== "" ? { title: f.title } : {}),
                  }
                : null;
        case "user_message":
        case "assistant_message":
            return typeof f.sessionId === "string" && typeof f.text === "string" ? { kind, sessionId: f.sessionId, text: f.text } : null;
        case "tool_call":
            return typeof f.sessionId === "string" && typeof f.tool === "string" ? { kind, sessionId: f.sessionId, tool: f.tool } : null;
        case "agent_end":
            return typeof f.sessionId === "string" ? { kind, sessionId: f.sessionId } : null;
        case "attention": {
            const item = f.item as AttentionItem | undefined;
            return item !== undefined && item !== null && typeof item.id === "string" && typeof item.kind === "string" && typeof item.sessionId === "string"
                ? { kind, item }
                : null;
        }
        case "summary": {
            // the reporter's summary frame carries the summary fields flat
            if (typeof f.sessionId !== "string" || typeof f.text !== "string") return null;
            return {
                kind,
                line: {
                    t: typeof f.t === "string" ? f.t : "",
                    sessionId: f.sessionId,
                    kind: "summary",
                    text: f.text,
                    by: typeof f.by === "string" ? f.by : "",
                },
            };
        }
        case "phase":
            return typeof f.sessionId === "string" && typeof f.phase === "string" ? { kind, sessionId: f.sessionId, phase: f.phase as Phase } : null;
        case "status":
            return { kind, ...(f.kindData !== undefined ? { kindData: f.kindData } : {}) };
        default:
            return null; // unknown kind — dropped silently
    }
};

/** Kinds needing a human (docs/05 §Widget counts). */
const HUMAN_KINDS: ReadonlySet<AttentionItem["kind"]> = new Set(["approval", "question", "blocked"]);

/** Fold one frame into the model. Pure: model in, next model out.
 * `at` (epoch ms) stamps session recency so the renderer orders rows by
 * last activity. */
export const applyFrame = (m: WidgetModel, evt: WidgetFrame, at: number = Date.now()): WidgetModel => {
    switch (evt.kind) {
        case "session_start": {
            const existing = m.sessions[evt.sessionId];
            const next: WidgetSession = {
                id: evt.sessionId,
                name: evt.title !== undefined && evt.title !== "" ? evt.title : (existing?.name ?? shortId(evt.sessionId)),
                phase: existing?.phase ?? "working",
                description: evt.attached ? "attached" : `started in ${evt.cwd || "?"}`,
                lastActivity: at,
            };
            return { ...m, sessions: { ...m.sessions, [evt.sessionId]: next } };
        }
        case "user_message":
            return withSession(m, evt.sessionId, (s) => ({ ...s, description: evt.text, lastActivity: at }));
        case "assistant_message":
            return withSession(m, evt.sessionId, (s) => ({ ...s, description: evt.text, lastActivity: at }));
        case "tool_call":
            return withSession(m, evt.sessionId, (s) => ({ ...s, description: `tool: ${evt.tool}`, lastActivity: at }));
        case "agent_end":
            return withSession(m, evt.sessionId, (s) => ({ ...s, phase: "idle", description: s.description, lastActivity: at }));
        case "attention": {
            const item = evt.item;
            const open = item.resolvedAt === undefined || item.resolvedAt === null;
            const withoutItem = m.attention.filter((i) => i.id !== item.id);
            // store order: raises append (status.json attention[] semantics),
            // so "top" = first raised open item, matching every surface
            return open ? { ...m, attention: [...withoutItem, item] } : { ...m, attention: withoutItem };
        }
        case "summary":
            return { ...m, summaryCount: m.summaryCount + 1, lastSummary: evt.line };
        case "phase": {
            if (!isPhase(evt.phase)) return m;
            return withSession(m, evt.sessionId, (s) => ({ ...s, phase: evt.phase as Phase, lastActivity: at }));
        }
        case "status":
            return m;
    }
};

// ---- helpers ----

const shortId = (id: string): string => id.slice(0, 4);

const withSession = (m: WidgetModel, sessionId: string, fn: (s: WidgetSession) => WidgetSession): WidgetModel => {
    const existing = m.sessions[sessionId];
    if (!existing) return m;
    return { ...m, sessions: { ...m.sessions, [sessionId]: fn(existing) } };
};

const isPhase = (v: string): v is Phase => v === "working" || v === "waiting" || v === "idle" || v === "blocked";

// ---- rendering ----

/** Hard line budget (docs/05 §Widget CONTRACT). */
export const WIDGET_MAX_LINES = 8;
/** Session rows between the orientation and the overflow/summary line. */
export const WIDGET_MAX_SESSION_ROWS = 5;

/** Truecolor escape for a session's hue bar; empty at plain level. */
const hueBarCodes = (sessionId: string, color: boolean): string => (color ? `\x1b[${hueColorCodes(sessionId)}m` : "");

const RESET = "\x1b[0m";

/** Parse NO_COLOR-style plain request: any non-empty value → plain. */
export const widgetColorEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.NO_COLOR === undefined || env.NO_COLOR === "";

/** Token color for the orientation counts: warn for ⚠, accent for ⏳, muted for 💤.
 * Hex values mirror lib TOKEN_HEX (the widget encodes SGR directly so the
 * extension boundary keeps zero lib/adapter imports beyond the barrel). */
const TOKEN_HEX_SGR = {
    warn: "38;2;245;192;78", // #f5c04e
    accent: "38;2;112;225;196", // #70e1c4
    muted: "38;2;139;151;176", // #8b97b0
} as const;

/** Truecolor SGR for a lib theme token. */
const tokenSgr = (token: keyof typeof TOKEN_HEX_SGR): string => `\x1b[${TOKEN_HEX_SGR[token]}m`;

/** Clamp a string to `n` cells (code points), appending `…` when clipped. */
const clipText = (text: string, n: number): string => {
    const line = text.split(/\r?\n/, 1)[0] ?? "";
    if (line.length <= n) return line;
    return `${line.slice(0, Math.max(1, n - 1))}…`;
};

/** Phase glyph (docs/05 example render). */
const phaseGlyph = (phase: Phase): string => {
    switch (phase) {
        case "working":
            return "▶";
        case "waiting":
            return "…";
        case "idle":
            return "💤";
        case "blocked":
            return "⚠";
    }
};

/** Widget render inputs — plain data so tests build them directly. */
export type WidgetRenderInput = {
    model: WidgetModel;
    /** current state: dimmed orientation (idle), live rows (busy), highlight (attach), summary flash */
    state: WidgetState;
    /** epoch ms of the last event (Clock value) — drives the idle threshold */
    lastEventAt: number;
    now: number;
    /** the hub.sock path for the footer */
    sockPath: string;
    color: boolean;
    /** session id whose row highlights (attach flash); undefined otherwise */
    attachSessionId?: string;
};

/** Widget display states (docs/05 §Widget states table). */
export type WidgetState = "idle" | "busy" | "attach" | "summary-flash";

/** Render the model into at most 8 lines. Pure; clips, never wraps.
 * Compact: slots with no content (rows, overflow, summary) are omitted —
 * docs/05's example render is 6 lines, footer always last. */
export const renderWidget = (input: WidgetRenderInput): string[] => {
    const { model, state, color } = input;
    const dim = state === "idle";
    const dimOpen = dim && color ? "\x1b[2m" : "";
    const dimClose = dim && color ? RESET : "";

    const lines: string[] = [];

    // line 1 — orientation: counts + top item + answer hint
    const items = model.attention.filter((i) => HUMAN_KINDS.has(i.kind));
    const sessions = Object.values(model.sessions);
    const working = sessions.filter((s) => s.phase === "working" || s.phase === "waiting").length;
    const idling = sessions.filter((s) => s.phase === "idle").length;
    const top = items[0];
    const topSessionName = top !== undefined ? (model.sessions[top.sessionId]?.name ?? shortId(top.sessionId)) : "";
    const parts: string[] = [
        color
            ? `${tokenSgr("warn")}⚠${items.length}${RESET} ${tokenSgr("accent")}⏳${working}${RESET} ${tokenSgr("muted")}💤${idling}${RESET}`
            : `⚠${items.length} ⏳${working} 💤${idling}`,
        top !== undefined ? `${dimOpen}·${dimClose} ${clipText(`${topSessionName}: ${top.text}`, 42)}` : "",
        top !== undefined ? `${dimOpen}· answer ${top.id}: …${dimClose}` : "",
    ].filter((p) => p !== "");
    lines.push(parts.join(" "));

    // lines 2–6 — session rows: hue bar + short id/title + phase glyph + description
    const ordered = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);
    const rows = ordered.slice(0, WIDGET_MAX_SESSION_ROWS);
    for (const s of rows) {
        const attach = state === "attach" && input.attachSessionId === s.id && color;
        const hlOpen = attach ? "\x1b[1m" : "";
        const hlClose = attach ? RESET : "";
        const body = `${clipText(s.name, 12).padEnd(4)} ${phaseGlyph(s.phase)} ${s.phase.padEnd(8)} ${clipText(s.description || "—", 34)}`;
        // plain level: no bar codes, no reset — zero escapes anywhere
        const row = color ? `${hueBarCodes(s.id, true)}▌${RESET}${hlOpen}${body}${hlClose}` : `▌${body}`;
        lines.push(dim ? `${dimOpen}${stripCodes(row)}${dimClose}` : row);
    }

    // line 7 — overflow or the newest summary (flash); slot exists only when
    // there is content (docs/05 example render: 6 lines — footer follows rows)
    const overflowSessions = sessions.length - rows.length;
    const overflowAttention = Math.max(0, items.length - 1);
    if (overflowSessions > 0 || overflowAttention > 0) {
        const bits: string[] = [];
        if (overflowAttention > 0) bits.push(`+${overflowAttention} more attention items`);
        if (overflowSessions > 0) bits.push(`+${overflowSessions} more sessions`);
        lines.push(bits.join(" · "));
    } else if (model.lastSummary !== null) {
        lines.push(clipText(`◈ ${model.lastSummary.text}`, 60));
    }

    // line 8 (footer) — socket path + summary count
    lines.push(`${input.sockPath} · summaries ${model.summaryCount}`);

    // hard budget: clip, never wrap (docs/05 CONTRACT)
    return lines.slice(0, WIDGET_MAX_LINES);
};

/** Strip ANSI escape sequences (idle dimming re-wraps whole rows). */
const stripCodes = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---- controller (state transitions + debounce + feed lifecycle) ----

/** Debounce window (docs/05 §Widget update triggers). */
export const WIDGET_DEBOUNCE_MS = 250;
/** No events for this long with no open attention → idle state. */
export const WIDGET_IDLE_MS = 30_000;
/** Reconnect backoff bounds (docs/05 §Widget degrade). */
export const WIDGET_RETRY_MIN_MS = 1_000;
export const WIDGET_RETRY_MAX_MS = 30_000;

/** Controllable edges so hub.ts stays a thin driver and tests inject fakes. */
export type WidgetHost = {
    /** paint the widget (setWidget under the omp-hub-stream key) */
    setWidget(lines: string[] | undefined): void;
};

export type WidgetControllerOptions = {
    sockPath: string;
    host: WidgetHost;
    scheduler: Scheduler;
    /** injected clock (epoch ms); defaults to Date.now — tests freeze it */
    now?: () => number;
    /** env for NO_COLOR; defaults to process.env */
    env?: NodeJS.ProcessEnv;
    /** subscribe function — inject a fake for tests; default is hub_sock's real feed */
    subscribe?: typeof subscribeHubFeed;
    /** reconnect backoff overrides (tests) */
    retryMinMs?: number;
    retryMaxMs?: number;
};

/**
 * The widget controller: owns the subscription, the local attention model,
 * the 250 ms trailing debounce, the state machine, and the paint. Any hub
 * event schedules one render; setWidget fires only when lines changed.
 * Hub offline → static `(hub offline)` state, reconnect with bounded backoff.
 */
export const createWidgetController = (opts: WidgetControllerOptions) => {
    const nowFn = opts.now ?? (() => Date.now());
    const color = widgetColorEnabled(opts.env);
    const retryMin = opts.retryMinMs ?? WIDGET_RETRY_MIN_MS;
    const retryMax = opts.retryMaxMs ?? WIDGET_RETRY_MAX_MS;

    let model = emptyWidgetModel();
    let state: WidgetState = "busy";
    let lastEventAt = nowFn();
    let attachSessionId: string | undefined;
    let attachConsumed = true;
    let lastPainted = "";
    let feed: HubFeedHandle | null = null;
    let unsubEvents: (() => void) | null = null;
    let unsubClose: (() => void) | null = null;
    let renderTimerCancel: (() => void) | null = null;
    let retryTimerCancel: (() => void) | null = null;
    let retryDelay = retryMin;
    let stopped = false;
    let summaryFlashUntil = 0;

    const paint = (): void => {
        const now = nowFn();
        // state resolution: summary-flash beats attach; attach survives exactly
        // one painted refresh (docs/05 §Widget states); idle only when quiet
        if (now < summaryFlashUntil) state = "summary-flash";
        else if (state === "attach" && attachSessionId !== undefined && !attachConsumed) {
            attachConsumed = true;
        } else if (state === "attach" && attachSessionId !== undefined && attachConsumed) {
            attachSessionId = undefined;
            state = "busy";
        } else if (now - lastEventAt >= WIDGET_IDLE_MS && model.attention.length === 0) state = "idle";
        else state = "busy";
        const lines = renderWidget({
            model,
            state,
            lastEventAt,
            now,
            sockPath: opts.sockPath,
            color,
            ...(attachSessionId !== undefined ? { attachSessionId } : {}),
        });
        const joined = lines.join("\n");
        if (joined !== lastPainted) {
            lastPainted = joined;
            opts.host.setWidget(lines);
        }
    };

    const scheduleRender = (): void => {
        if (renderTimerCancel) renderTimerCancel();
        // 250 ms trailing debounce: a burst of events costs exactly one render
        renderTimerCancel = opts.scheduler.setTimeout(() => {
            renderTimerCancel = null;
            paint();
        }, WIDGET_DEBOUNCE_MS);
    };

    const onFrame = (raw: Record<string, unknown>): void => {
        const evt = decodeFrame(raw);
        if (evt === null) return; // malformed/unknown frames dropped silently
        lastEventAt = nowFn();
        if (evt.kind === "session_start" && evt.attached) {
            // attach: that row highlights for one refresh (docs/05 §Widget states)
            attachSessionId = evt.sessionId;
            attachConsumed = false;
            state = "attach";
        }
        if (evt.kind === "summary") {
            summaryFlashUntil = nowFn() + WIDGET_DEBOUNCE_MS * 2;
        }
        model = applyFrame(model, evt, lastEventAt);
        scheduleRender();
    };

    const connect = (): void => {
        if (stopped) return;
        void opts.subscribe!(opts.sockPath).then((res) => {
            if (stopped) return;
            if (!res.ok) {
                enterOffline();
                return;
            }
            feed = res.feed;
            retryDelay = retryMin; // reset backoff after a successful connect
            unsubClose = feed.onClose(() => {
                teardownFeed();
                enterOffline();
            });
            unsubEvents = feed.on(onFrame);
            paint(); // attach is live immediately
        });
    };

    const teardownFeed = (): void => {
        unsubEvents?.();
        unsubEvents = null;
        unsubClose?.();
        unsubClose = null;
        feed?.close();
        feed = null;
    };

    const enterOffline = (): void => {
        if (stopped) return;
        // static degraded state (docs/05/docs/03: offline is rendered, not a crash)
        opts.host.setWidget([`(hub offline)`]);
        lastPainted = "(hub offline)";
        // bounded reconnect backoff: current delay first, then double up to the cap
        retryTimerCancel = opts.scheduler.setTimeout(() => {
            retryTimerCancel = null;
            connect();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, retryMax);
    };

    const start = (): void => {
        stopped = false;
        connect();
    };

    const handleEvent = (raw: Record<string, unknown>): void => {
        onFrame(raw);
    };

    /** True once the live feed closed and the offline state painted. */
    const isOffline = (): boolean => feed === null && retryTimerCancel !== null;

    const stop = (): void => {
        stopped = true;
        renderTimerCancel?.();
        renderTimerCancel = null;
        retryTimerCancel?.();
        retryTimerCancel = null;
        teardownFeed();
        opts.host.setWidget(undefined);
    };

    /** Test seams: current model/state without reaching into the closure. */
    const debug = () => ({ model, state, lastPainted });

    return { start, stop, handleEvent, isOffline, debug };
};

export type WidgetController = ReturnType<typeof createWidgetController>;
