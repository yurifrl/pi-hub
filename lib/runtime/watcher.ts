// lib/runtime/watcher.ts — the hub agent runtime (docs/06 §Hub agent): spawn
// spec for the `omp --mode acp` child, the event loop over the EventBus, the
// catch-up pass on restart, and the bounded-backoff supervision policy.
// Layering: imports domain + ports only (plus the barrel-internal classifier);
// all I/O stays in adapters — timers arrive through the Scheduler port.
import type { LogEntry, Phase, AttentionKind } from "../domain/session";
import { classifyBatch, idleSessions } from "../domain/describe";
import type { AttentionCandidate } from "../domain/attention";
import { proposeAttention } from "../domain/attention";
import type { StatusStore } from "../ports/status_store";
import type { SummaryStore } from "../ports/summary_store";
import type { AttentionStore } from "../ports/attention_store";
import type { EventBus } from "../ports/event_bus";
import type { AgentRuntime } from "../ports/agent_runtime";
import type { Clock } from "../ports/clock";
import type { Scheduler } from "../ports/scheduler";

/** The agent's own session ids, if known yet (anti-recursion guard 6). */
export type WatcherOptions = {
  runtime: AgentRuntime;
  bus: EventBus;
  status: StatusStore;
  summaries: SummaryStore;
  attention: AttentionStore;
  clock: Clock;
  scheduler: Scheduler;
  /** child name registered in status.json; default "hub-watcher" */
  name?: string;
  /** idle timeout for the idle phase/attention kind (docs/06 cadence) */
  idleTimeoutMs?: number;
  /** guard 6: session ids the watcher must never watch (seeded, e.g. after adoption) */
  selfIds?: string[];
  /** env the child reads (OMP_BIN, OMP_HUB_MODEL); resolved at the host edge */
  env?: { ompBin?: string; model?: string };
  /** trailing debounce per session for the agent_end summary pass */
  debounceMs?: number;
  /** supervision: restart cap before giving up */
  maxRestartAttempts?: number;
  /** supervision: first backoff delay; doubles per attempt */
  restartBackoffMs?: number;
  /** supervision: attempts reset after the agent stayed up this long */
  stableResetMs?: number;
};

export const WATCHER_DEFAULTS = {
  name: "hub-watcher",
  idleTimeoutMs: 15 * 60_000,
  debounceMs: 2_000,
  maxRestartAttempts: 5,
  restartBackoffMs: 1_000,
  stableResetMs: 5 * 60_000,
} as const;

/** The watcher performs every resolve it observes; the actor is always the agent. */
const WATCHER_CALLER = "agent" as const;

const agentSelfError = (message: string) => ({
  code: "denied" as const,
  message,
  retryable: false,
});

// ---- spawn spec (docs/06: three entry points, one path) ----

/**
 * The one spawn spec every entry point (CLI foreground, web toggle,
 * /hub-agent) resolves to. `becomeHub` mirrors guard 5: the agent may never
 * become the hub — refused when OMP_HUB_AGENT is already set.
 */
export type SpawnSpec = {
  bin: string;
  args: string[];
  env: Record<string, string>;
  name: string;
  kind: "agent";
  agentSurface: "watcher" | "pending";
};

export const buildSpawnSpec = (opts: {
  /** OMP_BIN value (omp binary); required by contract */
  ompBin: string;
  /** OMP_HUB_MODEL value when set (small fast model beats frontier here) */
  model?: string;
  /** target surface; default watcher (docs/06: demo pending) */
  agentSurface?: "watcher" | "pending";
  name?: string;
  /** guard 5 — the caller checks OMP_HUB_AGENT in its environment */
  alreadyHubAgent?: boolean;
}): SpawnSpec | { error: ReturnType<typeof agentSelfError> } => {
  if (opts.alreadyHubAgent) {
    return {
      error: agentSelfError("this session is the hub agent (OMP_HUB_AGENT=1); refusing to nest the hub inside its own agent"),
    };
  }
  const env: Record<string, string> = { OMP_HUB_AGENT: "1" };
  if (opts.model !== undefined) env.OMP_HUB_MODEL = opts.model;
  return {
    bin: opts.ompBin,
    args: ["--mode", "acp"],
    env,
    name: opts.name ?? WATCHER_DEFAULTS.name,
    kind: "agent",
    agentSurface: opts.agentSurface ?? "watcher",
  };
};

// ---- watcher runtime ----

type OpenItem = { id: string; kind: AttentionKind };

export type WatcherRuntime = {
  /** idempotent: subscribes, spawns the child, runs catch-up, enters the loop */
  start(): Promise<void>;
  /** unsubscribes and stops supervision; the child is left to the host's dispose path */
  stop(): void;
  /** snapshot for tests/hosts: agent session id, restart state */
  state(): { agentSessionId: string | null; restarts: number; running: boolean };
};

/** Normalize an unknown EventBus payload into a LogEntry, or null. */
const asLogEntry = (payload: unknown): LogEntry | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const kinds = ["session_start", "user_message", "assistant_message", "tool_call", "agent_end"];
  if (typeof p.sessionId !== "string" || typeof p.kind !== "string") return null;
  if (!kinds.includes(p.kind)) return null;
  return {
    t: typeof p.t === "number" ? p.t : 0,
    sessionId: p.sessionId,
    kind: p.kind as LogEntry["kind"],
    text: typeof p.text === "string" ? p.text : "",
  };
};

const iso = (clock: Clock): string => new Date(clock.now()).toISOString();

export const startWatcher = (opts: WatcherOptions): WatcherRuntime => {
  const cfg = { ...WATCHER_DEFAULTS, ...opts };
  let agentSessionId: string | null = null;
  // guard 6: every id the watcher must not watch (spawned child + adopted id
  // from status.json after a restart, or seeded by the host).
  const selfIds = new Set<string>(opts.selfIds ?? []);
  let subscribed = false;
  let running = false;
  let restarts = 0;
  let lastSpawnAt = 0;

  // Per-session trailing debounce for the agent_end summary pass.
  const pendingSummaries = new Set<string>();
  const summaryTimers = new Map<string, () => void>();
  // Latest attention-bearing candidate per (session, kind) awaiting the pass.
  const raiseQueue = new Map<string, AttentionCandidate>();
  // Phase currently recorded per session (mirror of status.json).
  const phases = new Map<string, Phase>();
  const lastActivity = new Map<string, number>();
  const openItems = new Map<string, OpenItem[]>(); // sessionId -> open items

  // Latest known attention kind per session (last item in the append-ordered
  // attention array, open or resolved). The catch-up re-raise labels by it so
  // a question item does not come back as "approval" after a restart.
  const openKinds = new Map<string, AttentionKind>();

  const isSelf = (sessionId: string): boolean => selfIds.has(sessionId);

  // ---- status.json submit (step 3): the hub writer owns the file ----
  const submitPhase = async (sessionId: string, phase: Phase, description: string): Promise<void> => {
    const res = await cfg.status.update((s) => {
      const rec = s.sessions[sessionId];
      if (!rec) return s; // roster rows are the reporter's job
      const changed = rec.phase !== phase || rec.description !== description;
      if (!changed) return s;
      const history = [...(rec.phaseHistory ?? []), { phase, at: iso(cfg.clock) }].slice(-50);
      return {
        ...s,
        sessions: {
          ...s.sessions,
          [sessionId]: { ...rec, phase, description, phaseHistory: history, lastActivity: iso(cfg.clock) },
        },
      };
    });
    if (res.ok) phases.set(sessionId, phase);
  };

  // ---- summaries (step 4): ≤2 sentences per session turn ----
  const firstSentence = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed) return "";
    const m = trimmed.match(/^.*?[.!?](?:\s|$)/s);
    return (m ? m[0] : trimmed).trim();
  };

  const writeSummary = async (sessionId: string, text: string): Promise<void> => {
    if (isSelf(sessionId)) return; // guard 6: never summarize the watcher
    const line = {
      t: iso(cfg.clock),
      sessionId,
      kind: "summary" as const,
      text: firstSentence(text) || "turn complete",
      by: cfg.name,
    };
    await cfg.summaries.append(line);
  };

  // ---- attention (step 5): raise/update, never duplicate ----
  const submitAttention = async (candidate: AttentionCandidate): Promise<void> => {
    if (isSelf(candidate.sessionId)) return; // guard 6
    await cfg.attention.raise(candidate);
  };

  const resolveIfOpen = async (sessionId: string, kinds: string[]): Promise<void> => {
    const items = openItems.get(sessionId) ?? [];
    for (const item of items) {
      if (!kinds.includes(item.kind)) continue;
      await cfg.attention.resolve(item.id, undefined, WATCHER_CALLER);
    }
    openItems.set(sessionId, items.filter((item) => !kinds.includes(item.kind)));
  };

  const refreshOpenItems = async (): Promise<void> => {
    const res = await cfg.status.read();
    if (!res.ok) return;
    const bySession = new Map<string, OpenItem[]>();
    for (const item of res.value.attention) {
      if (item.resolvedAt !== undefined) continue;
      const list = bySession.get(item.sessionId) ?? [];
      list.push({ id: item.id, kind: item.kind });
      bySession.set(item.sessionId, list);
    }
    openItems.clear();
    openKinds.clear();
    for (const item of res.value.attention) {
      openKinds.set(item.sessionId, item.kind); // array is append-ordered: last wins
    }
    for (const [k, v] of bySession) openItems.set(k, v);
  };

  // ---- classification pipeline (steps 2+3) ----
  const applyClassifications = async (
    classifications: ReturnType<typeof classifyBatch>,
  ): Promise<void> => {
    for (const c of Object.values(classifications)) {
      if (isSelf(c.sessionId)) continue;
      const s0 = phases.get(c.sessionId); // phase recorded before this batch
      await submitPhase(c.sessionId, c.phase, c.description);
      if (c.phase === "working" && (s0 === "waiting" || s0 === "blocked")) {
        // Resolution pass, transition branch (docs/06): the failure cleared /
        // the tool proceeded — the session is working again, so nothing may
        // stay queued on the user. The phase move resolves the open items.
        await resolveIfOpen(c.sessionId, ["approval", "question", "blocked"]);
      }
      if (c.phase === "waiting" || c.phase === "blocked") {
        const kind = c.phase === "waiting" ? null : "blocked";
        const evidence = kind
          ? null
          : raiseQueue.get(`${c.sessionId}:approval`) ?? raiseQueue.get(`${c.sessionId}:question`);
        if (kind === "blocked") {
          const blocked = raiseQueue.get(`${c.sessionId}:blocked`);
          if (blocked) {
            await submitAttention(blocked);
            raiseQueue.delete(`${c.sessionId}:blocked`);
          }
        } else if (evidence) {
          await submitAttention(evidence);
          raiseQueue.delete(`${c.sessionId}:approval`);
          raiseQueue.delete(`${c.sessionId}:question`);
        }
      }
    }
  };

  // ---- the loop, per event batch (docs/06 steps 1–5) ----
  const pending: LogEntry[] = [];
  let flushTimer: (() => void) | null = null;
  let unsub: (() => void) | null = null;

  const flush = async (): Promise<void> => {
    flushTimer = null;
    const batch = pending.splice(0, pending.length);
    if (batch.length === 0) return;

    const states: Record<string, { phase: Phase; lastActivityAt: number }> = {};
    for (const e of batch) {
      states[e.sessionId] = {
        phase: phases.get(e.sessionId) ?? "working",
        lastActivityAt: lastActivity.get(e.sessionId) ?? (e.t || cfg.clock.now()),
      };
    }
    // Mirror the batch's own timestamps as activity.
    for (const e of batch) lastActivity.set(e.sessionId, e.t || cfg.clock.now());

    const filtered = batch.filter((e) => !isSelf(e.sessionId));
    const classifications = classifyBatch(filtered, states);

    // Queue attention candidates from the batch for the raise pass.
    for (const e of filtered) {
      if (e.kind !== "tool_call" && e.kind !== "assistant_message") continue;
      const candidate = proposeAttention(e, { now: cfg.clock.now() });
      if (candidate) raiseQueue.set(`${e.sessionId}:${candidate.kind}`, candidate);
    }

    await applyClassifications(classifications);
    await refreshOpenItems();

    // Resolution pass: user reply or any new activity clears waiting/blocked;
    // activity also clears idle (docs/06: "observes the user reply, the tool
    // proceeding, or the failure cleared").
    for (const e of filtered) {
      if (e.kind === "user_message") {
        await resolveIfOpen(e.sessionId, ["approval", "question", "idle", "blocked"]);
      } else if (e.kind === "tool_call" || e.kind === "assistant_message") {
        await resolveIfOpen(e.sessionId, ["idle"]);
      }
    }

    // agent_end → trailing-debounced summary per session turn.
    for (const e of filtered) {
      if (e.kind !== "agent_end") continue;
      if (pendingSummaries.has(e.sessionId)) continue;
      pendingSummaries.add(e.sessionId);
      const cancel = cfg.scheduler.setTimeout(() => {
        summaryTimers.delete(e.sessionId);
        pendingSummaries.delete(e.sessionId);
        void writeSummary(e.sessionId, e.text || "turn complete");
      }, cfg.debounceMs);
      summaryTimers.set(e.sessionId, cancel);
    }
  };

  const onEvent = (evt: { topic: string; payload: unknown }): void => {
    if (evt.topic !== "log") return;
    const entry = asLogEntry(evt.payload);
    if (!entry) return;
    if (entry.sessionId === agentSessionId) return; // guard 6: never watch itself
    pending.push(entry);
    if (flushTimer === null) {
      flushTimer = cfg.scheduler.setTimeout(() => void flush(), 0);
    }
  };

  // ---- idle timeout check (docs/06: "once per idle episode", Scheduler-scheduled) ----
  // Guard 6: the watcher never phases itself. Catch-up mirrors every
  // status.json row (including the adopted self id) into phases, while self
  // events never refresh lastActivity (onEvent filters them) — without the
  // exclusion the idle pass would permanently idle the watcher's own row.
  const checkIdle = (): void => {
    const states: Record<string, { phase: Phase; lastActivityAt: number }> = {};
    for (const [id, phase] of phases) {
      if (isSelf(id)) continue; // guard 6: never idle our own session
      states[id] = { phase, lastActivityAt: lastActivity.get(id) ?? 0 };
    }
    const idle = idleSessions(new Set(pending.map((e) => e.sessionId)), states, {
      now: cfg.clock.now(),
      idleTimeoutMs: cfg.idleTimeoutMs,
    });
    for (const sessionId of idle) {
      void (async () => {
        await submitPhase(sessionId, "idle", "idle past timeout; nothing queued");
        await submitAttention({
          sessionId,
          kind: "idle",
          text: "idle past timeout; nothing queued",
          evidence: [],
        });
      })();
    }
  };

  // Re-arm the idle check on a fixed cadence — the only periodic timer the
  // watcher owns (docs/06: "no polling loops — the Clock port provides the
  // only timers"). Each fire re-reads live state; batches already carry events.
  const armIdleCheck = (): void => {
    cfg.scheduler.setTimeout(() => {
      if (!running) return;
      checkIdle();
      armIdleCheck();
    }, cfg.idleTimeoutMs);
  };

  // ---- catch-up pass (docs/06: on restart, re-derive from durable state) ----
  const catchUp = async (): Promise<void> => {
    const res = await cfg.status.read();
    if (!res.ok) return;
    const snapshot = res.value;
    if (snapshot.agentSession !== undefined) {
      agentSessionId = snapshot.agentSession;
      selfIds.add(snapshot.agentSession); // adopt the existing agent id
    }

    phases.clear();
    lastActivity.clear();
    for (const [id, rec] of Object.entries(snapshot.sessions)) {
      phases.set(id, rec.phase);
      lastActivity.set(id, Date.parse(rec.lastActivity) || 0);
    }
    await refreshOpenItems();

    // Re-raise missing items from current process state: a session whose
    // recorded phase is waiting/blocked with no matching open item gets one.
    for (const [id, rec] of Object.entries(snapshot.sessions)) {
      if (isSelf(id)) continue;
      const wanted = rec.phase === "waiting" || rec.phase === "blocked";
      const hasOpen = (openItems.get(id) ?? []).length > 0;
      if (wanted && !hasOpen) {
        // Preserve the recorded cause kind (approval vs question vs blocked);
        // the description never said which — re-raise must not mislabel.
        await submitAttention({
          sessionId: id,
          kind: openKinds.get(id) ?? (rec.phase === "blocked" ? "blocked" : "approval"),
          text: rec.description ?? "re-raised after watcher restart",
          evidence: [],
        });
      }
      // Re-derive phase: recorded lastActivity older than the idle timeout
      // and phase working → idle (catch-up replaces replay).
      if (rec.phase === "working" && cfg.clock.now() - (lastActivity.get(id) ?? 0) >= cfg.idleTimeoutMs) {
        await submitPhase(id, "idle", "idle past timeout; nothing queued");
        await submitAttention({
          sessionId: id,
          kind: "idle",
          text: "idle past timeout; nothing queued",
          evidence: [],
        });
      }
    }
  };

  // ---- supervision: bounded backoff, attempts reset after stability ----
  const backoffDelay = (attempt: number): number =>
    (cfg.restartBackoffMs ?? WATCHER_DEFAULTS.restartBackoffMs) * 2 ** Math.min(attempt - 1, 5);

  const supervise = (): void => {
    if (!running) return;
    const attempt = restarts + 1;
    if (attempt > (cfg.maxRestartAttempts ?? WATCHER_DEFAULTS.maxRestartAttempts)) {
      running = false; // give up; surfaces render last status.json marked stale
      return;
    }
    restarts = attempt;
    const delay = backoffDelay(attempt);
    cfg.scheduler.setTimeout(() => {
      if (!running) return;
      void spawnAgent();
    }, delay);
  };

  const spawnAgent = async (): Promise<void> => {
    const ompBin = cfg.env?.ompBin ?? "omp";
    const model = cfg.env?.model;
    const spec = buildSpawnSpec({ ompBin, ...(model !== undefined ? { model } : {}) });
    if ("error" in spec) {
      running = false;
      return;
    }
    const res = await cfg.runtime.spawn({ name: spec.name, ...(spec.env.OMP_HUB_MODEL !== undefined ? { model: spec.env.OMP_HUB_MODEL } : {}) });
    if (!res.ok) {
      supervise();
      return;
    }
    if (cfg.clock.now() - lastSpawnAt > (cfg.stableResetMs ?? WATCHER_DEFAULTS.stableResetMs)) {
      restarts = 0; // stable long enough: attempts reset
    }
    lastSpawnAt = cfg.clock.now();
    if (res.value.sessionId !== null) {
      agentSessionId = res.value.sessionId;
      selfIds.add(res.value.sessionId);
    }
  };

  const start = async (): Promise<void> => {
    if (subscribed) return;
    subscribed = true;
    running = true;
    unsub = cfg.bus.subscribe(onEvent);
    await catchUp();
    armIdleCheck();
    await spawnAgent();
  };

  const stop = (): void => {
    running = false;
    if (unsub) {
      unsub(); // release the bus subscription (docs/01: stop() releases it)
      unsub = null;
    }
    subscribed = false;
    if (flushTimer !== null) {
      flushTimer(); // drop the in-flight debounce timer with the subscription
      flushTimer = null;
    }
    for (const cancel of summaryTimers.values()) cancel();
    summaryTimers.clear();
    pendingSummaries.clear();
    raiseQueue.clear();
  };

  return {
    start,
    stop,
    state: () => ({ agentSessionId, selfIds: [...selfIds], restarts, running }),
  };
};
