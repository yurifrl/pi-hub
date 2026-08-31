// lib/runtime/watcher.test.ts — the watcher loop with fakes (docs/01 §Testing:
// domain pure, edges faked): fake EventBus, fake stores, fake AgentRuntime,
// manual Scheduler. Covers the acceptance flows: batch classify → submit →
// summarize → raise/resolve; idempotent re-raise; agent-self exclusion;
// catch-up without replay; bounded backoff restart.
import { describe, it, expect, beforeEach } from "bun:test";
import { startWatcher, buildSpawnSpec, WATCHER_DEFAULTS } from "./watcher";
import type { Result, HubError } from "../domain/command";
import type { LogEntry, StatusFile, AttentionItem, SummaryLine } from "../domain/session";
import type { EventBus } from "../ports/event_bus";
import type { HubEvent } from "../domain/session";
import type { StatusStore } from "../ports/status_store";
import type { SummaryStore } from "../ports/summary_store";
import type { AttentionStore } from "../ports/attention_store";
import type { AgentRuntime, AgentHandle } from "../ports/agent_runtime";

// ---- fakes ----

type Timer = { id: number; at: number; fn: () => void };

const makeClock = (start: number) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
};

const makeScheduler = (clock: ReturnType<typeof makeClock>) => {
  let nextId = 1;
  const timers = new Map<number, Timer>();
  const api = {
    setTimeout(fn: () => void, ms: number): () => void {
      const id = nextId++;
      timers.set(id, { id, at: clock.now() + ms, fn });
      return () => timers.delete(id);
    },
    /** run every timer scheduled at or before clock.now(), in time order */
    runDue(): number {
      let ran = 0;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const due = [...timers.values()].filter((tm) => tm.at <= clock.now()).sort((a, b) => a.at - b.at);
        for (const tm of due) {
          timers.delete(tm.id);
          tm.fn();
          ran++;
          progressed = true;
        }
      }
      return ran;
    },
    pending: () => timers.size,
  };
  return api;
};

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

const makeStores = (initial?: Partial<StatusFile>, selfIds: string[] = []) => {
  const statusFile: StatusFile = {
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    pid: 1,
    nextAttentionId: 1,
    sessions: initial?.sessions ?? {},
    attention: initial?.attention ?? [],
    archived: [],
  };
  const attention: AttentionItem[] = statusFile.attention;
  const summaries: SummaryLine[] = [];
  let raises = 0;
  let resolves = 0;

  const status: StatusStore = {
    read: async () => ok(structuredClone(statusFile)),
    update: async (mutate) => {
      // hub-writer contract: the mutator's RESULT is written back (docs/01)
      const next = mutate(statusFile);
      Object.assign(statusFile, next);
      statusFile.attention = attention; // keep the canonical array identity
      return ok(structuredClone(statusFile));
    },
  };

  const attentionStore: AttentionStore = {
    list: (f) => ok(attention.filter((i) => !f || f.id === undefined || i.sessionId === f.id)),
    raise: async (c) => {
      raises++;
      // one open item per (session, cause): re-raise updates text, never duplicates
      const existing = attention.find((i) => i.resolvedAt === undefined && i.sessionId === c.sessionId && i.kind === c.kind);
      if (existing) {
        existing.text = c.text;
        return ok(existing);
      }
      // the AttentionStore REJECTS items whose sessionId is the agent's (guard 6)
      if (c.sessionId === agentSessionIdRef()) {
        return { ok: false, error: { code: "denied", message: "agent session cannot raise attention", retryable: false } };
      }
      const item: AttentionItem = {
        id: `att-${statusFile.nextAttentionId++}`,
        sessionId: c.sessionId,
        kind: c.kind,
        text: c.text,
        createdAt: new Date().toISOString(),
      };
      attention.push(item);
      return ok(item);
    },
    resolve: async (id, answer) => {
      resolves++;
      const item = attention.find((i) => i.id === id);
      if (!item) return { ok: false, error: { code: "unknown-session", message: `no item ${id}`, retryable: false } };
      if (item.resolvedAt !== undefined) return ok(item); // idempotent
      item.resolvedAt = new Date().toISOString();
      if (answer !== undefined) item.answer = answer;
      return ok(item);
    },
  };

  const summaryStore: SummaryStore = {
    append: async (line) => {
      summaries.push(line);
      return ok(undefined);
    },
    tail: async (n) => ok(summaries.slice(-n)),
  };

  const agentSessionIdRef = () => statusFile.agentSession ?? (selfIds.length > 0 ? selfIds[0]! : "");

  return { statusFile, attention, summaries, status, attentionStore, summaryStore, counts: { get raises() { return raises; }, get resolves() { return resolves; } }, selfIds };
};

const makeRuntime = (opts: { failTimes?: number; sessionId?: string | null } = {}) => {
  let failuresLeft = opts.failTimes ?? 0;
  let spawnCalls = 0;
  const spawnArgs: Array<{ name?: string; model?: string }> = [];
  const handleFor = (i: number): AgentHandle => ({
    name: "hub-watcher",
    sessionId: opts.sessionId !== undefined ? opts.sessionId : `agent-${i}`,
  });
  const runtime: AgentRuntime = {
    spawn: async (spec) => {
      spawnCalls++;
      spawnArgs.push(spec);
      if (failuresLeft > 0) {
        failuresLeft--;
        return { ok: false, error: { code: "unavailable-hub", message: "spawn failed", retryable: true } };
      }
      return ok(handleFor(spawnCalls));
    },
    send: async () => ok(undefined),
    kill: async () => ok(undefined),
  };
  return { runtime, spawnCalls: () => spawnCalls, spawnArgs };
};

const makeBus = () => {
  const handlers: Array<(evt: HubEvent) => void> = [];
  const bus: EventBus = {
    publish: (evt: HubEvent) => {
      for (const h of handlers) h(evt);
    },
    subscribe: (fn) => {
      handlers.push(fn);
      return () => {
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
  return { bus, publish: bus.publish, handlerCount: () => handlers.length };
};

const makeEnv = (opts: { status?: Partial<StatusFile>; failTimes?: number; sessionId?: string | null; selfIds?: string[] } = {}) => {
  const clock = makeClock(1_000_000);
  const scheduler = makeScheduler(clock);
  const selfIds = opts.selfIds ?? (opts.sessionId !== undefined && opts.sessionId !== null ? [opts.sessionId] : []);
  const stores = makeStores(opts.status, selfIds);
  const agent = makeRuntime(opts);
  const eb = makeBus();
  return { clock, scheduler, ...stores, ...agent, bus: eb.bus, publish: eb.publish, handlerCount: eb.handlerCount };
};

// ---- helpers ----

const logEntry = (over: Partial<LogEntry>): LogEntry => ({
  t: 1_000_000,
  sessionId: "s-1",
  kind: "assistant_message",
  text: "reading the config",
  ...over,
});

const baseOpts = (env: ReturnType<typeof makeEnv>) => ({
  runtime: env.runtime,
  bus: env.bus,
  status: env.status,
  summaries: env.summaryStore,
  attention: env.attentionStore,
  clock: env.clock,
  scheduler: env.scheduler,
  selfIds: env.selfIds,
});

/** Drain microtasks so the async flush/spawn chains settle deterministically. */
const tick = async (env: ReturnType<typeof makeEnv>) => {
  env.scheduler.runDue();
  for (let i = 0; i < 100; i++) await Promise.resolve();
  env.scheduler.runDue();
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

// ---- tests ----

describe("watcher loop", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv({
      status: {
        sessions: {
          "s-1": {
            status: "open",
            kind: "peer",
            cwd: "/tmp",
            title: "tilt",
            model: "m",
            phase: "working",
            log: "logs/s-1.jsonl",
            toolCounts: {},
            turns: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastActivity: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });
  });

  it("batch classify → submit phase+description to the hub writer", async () => {
    const w = startWatcher(baseOpts(env));
    await w.start();
    env.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "bun test" }) });
    await tick(env);

    const rec = env.statusFile.sessions["s-1"]!;
    expect(rec.phase).toBe("working");
    expect(rec.description).toContain("running");
  });

  it("approval-shaped tool_call → waiting phase + attention item raised", async () => {
    const w = startWatcher(baseOpts(env));
    await w.start();
    env.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "permission request: run bun test" }) });
    await tick(env);

    expect(env.statusFile.sessions["s-1"]!.phase).toBe("waiting");
    expect(env.attention).toHaveLength(1);
    expect(env.attention[0]!.kind).toBe("approval");
  });

  it("agent_end → trailing-debounced summary (≤2 sentences) in summaries.jsonl", async () => {
    const w = startWatcher(baseOpts(env));
    await w.start();
    env.publish({
      topic: "log",
      payload: logEntry({ kind: "agent_end", text: "deploy canary 2/3 done. waiting on approval. extra ignored." }),
    });
    await tick(env);
    env.clock.advance(WATCHER_DEFAULTS.debounceMs + 1);
    await tick(env);

    expect(env.summaries).toHaveLength(1);
    const line = env.summaries[0]!;
    expect(line.kind).toBe("summary");
    expect(line.sessionId).toBe("s-1");
    expect(line.text.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
  });

  it("user reply resolves open attention items", async () => {
    const w = startWatcher(baseOpts(env));
    await w.start();
    env.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "confirm the disk wipe" }) });
    await tick(env);
    expect(env.attention).toHaveLength(1);

    env.publish({ topic: "log", payload: logEntry({ kind: "user_message", text: "yes, proceed" }) });
    await tick(env);
    expect(env.attention.every((i) => i.resolvedAt !== undefined)).toBe(true);
  });

  it("re-raise updates text, never duplicates (one open item per session+cause)", async () => {
    const w = startWatcher(baseOpts(env));
    await w.start();
    env.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "permission request: first" }) });
    await tick(env);
    env.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "permission request: second" }) });
    await tick(env);

    const open = env.attention.filter((i) => i.resolvedAt === undefined);
    expect(open).toHaveLength(1);
    expect(open[0]!.text).toContain("second");
  });
});

describe("anti-recursion (guard 6)", () => {
  it("events from the agent's own session never raise, summarize, or phase-update", async () => {
    const env = makeEnv({ sessionId: "agent-1" });
    const w = startWatcher(baseOpts(env));
    await w.start();
    expect(w.state().agentSessionId).toBe("agent-1");

    env.publish({ topic: "log", payload: logEntry({ sessionId: "agent-1", kind: "tool_call", text: "permission request: from the watcher itself" }) });
    await tick(env);
    env.clock.advance(WATCHER_DEFAULTS.debounceMs + 1);
    await tick(env);

    expect(env.attention).toHaveLength(0);
    expect(env.summaries).toHaveLength(0);
  });

  it("the AttentionStore rejects items whose sessionId is the agent's", async () => {
    const env = makeEnv({ sessionId: "agent-1" });
    const res = await env.attentionStore.raise({
      sessionId: "agent-1",
      kind: "approval",
      text: "self-raise attempt",
      evidence: [],
    });
    expect(res.ok).toBe(false);
  });

  it("buildSpawnSpec refuses when already the hub agent (guard 5)", () => {
    const spec = buildSpawnSpec({ ompBin: "omp", alreadyHubAgent: true });
    expect("error" in spec).toBe(true);
  });
});

describe("spawn spec", () => {
  it("matches docs/05: OMP_BIN --mode acp, OMP_HUB_AGENT=1, OMP_HUB_MODEL when set", () => {
    const spec = buildSpawnSpec({ ompBin: "/usr/local/bin/omp", model: "haiku" });
    if (!("error" in spec)) {
      expect(spec.bin).toBe("/usr/local/bin/omp");
      expect(spec.args).toEqual(["--mode", "acp"]);
      expect(spec.env.OMP_HUB_AGENT).toBe("1");
      expect(spec.env.OMP_HUB_MODEL).toBe("haiku");
      expect(spec.kind).toBe("agent");
      expect(spec.agentSurface).toBe("watcher");
    } else {
      expect.unreachable();
    }
  });

  it("pending surface for the demo agent; no model env when unset", () => {
    const spec = buildSpawnSpec({ ompBin: "omp", agentSurface: "pending" });
    if (!("error" in spec)) {
      expect(spec.agentSurface).toBe("pending");
      expect("OMP_HUB_MODEL" in spec.env).toBe(false);
    } else {
      expect.unreachable();
    }
  });
});

describe("supervision — bounded backoff", () => {
  it("retries on failure with doubling delays, capped attempts, reset after stability", async () => {
    const env = makeEnv({ failTimes: 2 });
    const w = startWatcher(baseOpts(env));
    await w.start(); // first spawn fails → backoff scheduled
    expect(w.state().restarts).toBe(1);
    expect(env.spawnCalls()).toBe(1);

    env.clock.advance(WATCHER_DEFAULTS.restartBackoffMs); // attempt 2 (1s delay)
    await tick(env);
    expect(env.spawnCalls()).toBe(2);
    expect(w.state().restarts).toBe(2);

    env.clock.advance(WATCHER_DEFAULTS.restartBackoffMs * 2); // attempt 3 (2s delay)
    await tick(env);
    expect(env.spawnCalls()).toBe(3);
    expect(w.state().restarts).toBe(0); // stable reset on success
    expect(w.state().running).toBe(true);
  });

  it("gives up after maxRestartAttempts", async () => {
    const env = makeEnv({ failTimes: 99 });
    const w = startWatcher(baseOpts(env));
    await w.start();
    expect(w.state().restarts).toBe(1);

    for (let i = 0; i < WATCHER_DEFAULTS.maxRestartAttempts; i++) {
      env.clock.advance(WATCHER_DEFAULTS.restartBackoffMs * 2 ** i);
      await tick(env);
    }
    expect(w.state().running).toBe(false); // gave up; surfaces render last status marked stale
  });

  it("env is injected, not read from process.env (docs/01 layering)", async () => {
    const env = makeEnv({ sessionId: "agent-e" });
    const w = startWatcher({ ...baseOpts(env), env: { ompBin: "/opt/omp/bin/omp", model: "haiku" } });
    await w.start();
    expect(env.spawnArgs[0]).toEqual({ name: "hub-watcher", model: "haiku" });
    w.stop();
  });
});

describe("catch-up pass (restart)", () => {
  it("re-derives phases and re-raises missing items WITHOUT replaying old events", async () => {
    const env = makeEnv({
      status: {
        agentSession: "agent-0",
        sessions: {
          "s-wait": {
            status: "open",
            kind: "peer",
            cwd: "/tmp",
            title: "waiting session",
            model: "m",
            phase: "waiting",
            description: "awaiting approval: deploy canary",
            log: "logs/s-wait.jsonl",
            toolCounts: {},
            turns: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastActivity: "2026-01-01T00:00:00.000Z",
          },
          "s-idle": {
            status: "open",
            kind: "peer",
            cwd: "/tmp",
            title: "idle session",
            model: "m",
            phase: "working",
            log: "logs/s-idle.jsonl",
            toolCounts: {},
            turns: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastActivity: new Date(1_000_000 - 60 * 60_000).toISOString(), // long past
          },
        },
      },
    });
    const w = startWatcher({ ...baseOpts(env), idleTimeoutMs: 5 * 60_000 });
    await w.start();

    // waiting session: phase kept, item re-raised (missing open item)
    expect(env.statusFile.sessions["s-wait"]!.phase).toBe("waiting");
    const raised = env.attention.filter((i) => i.sessionId === "s-wait");
    expect(raised).toHaveLength(1);

    // idle session: working + quiet past timeout → idle flip
    expect(env.statusFile.sessions["s-idle"]!.phase).toBe("idle");
    const idleItems = env.attention.filter((i) => i.sessionId === "s-idle");
    expect(idleItems).toHaveLength(1);
    expect(idleItems[0]!.kind).toBe("idle");

    // no replay: publishing nothing, no old events processed
    expect(env.summaries).toHaveLength(0);
  });

  it("re-raise preserves the original kind: question does not come back as approval", async () => {
    // Session recorded waiting; its question item was answered while the
    // watcher was down (resolvedAt set, phase update lost in the crash).
    // Catch-up re-raises with the recorded kind, not a blanket "approval".
    const env = makeEnv({
      status: {
        attention: [
          {
            id: "att-1",
            sessionId: "s-q",
            kind: "question",
            text: "which region?",
            createdAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: "2026-01-01T00:05:00.000Z",
            answer: "eu-west",
          },
        ],
        sessions: {
          "s-q": {
            status: "open",
            kind: "peer",
            cwd: "/tmp",
            title: "asking",
            model: "m",
            phase: "waiting",
            description: "asked you: which region?",
            log: "logs/s-q.jsonl",
            toolCounts: {},
            turns: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastActivity: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });
    const w = startWatcher(baseOpts(env));
    await w.start();
    const raised = env.attention.filter((i) => i.sessionId === "s-q" && i.resolvedAt === undefined);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.kind).toBe("question");
    w.stop();
  });

  it("adopted agentSession from status.json is excluded from watching", async () => {
    const env = makeEnv({
      status: { agentSession: "agent-adopted" },
    });
    // spawn adopts the existing agent id from status
    env.statusFile.agentSession = "agent-adopted";
    const w = startWatcher(baseOpts(env));
    await w.start();
    env.publish({ topic: "log", payload: logEntry({ sessionId: "agent-adopted", kind: "tool_call", text: "permission request" }) });
    await tick(env);
    expect(env.attention).toHaveLength(0);
  });

  it("never idles the watcher's own row (guard 6 vs the idle pass)", async () => {
    // The REJECT scenario: catch-up adopts a self id (old agentSession row in
    // status.json), no self events ever refresh lastActivity, the idle pass
    // fires past the timeout — the watcher's own row must stay untouched.
    const env = makeEnv({ sessionId: "agent-live" });
    env.statusFile.agentSession = "agent-live";
    env.statusFile.sessions["agent-live"] = {
      status: "open",
      kind: "agent",
      cwd: "/tmp",
      title: "hub watcher",
      model: "m",
      phase: "working",
      log: "logs/agent-live.jsonl",
      toolCounts: {},
      turns: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivity: new Date(1_000_000 - 60 * 60_000).toISOString(), // long quiet
    };
    const w = startWatcher({ ...baseOpts(env), idleTimeoutMs: 5 * 60_000 });
    await w.start();
    expect(w.state().agentSessionId).toBe("agent-live");

    env.clock.advance(6 * 60_000); // past idleTimeoutMs
    await tick(env);
    expect(env.statusFile.sessions["agent-live"]!.phase).toBe("working");
    expect(env.attention.filter((i) => i.sessionId === "agent-live")).toHaveLength(0);
  });
});

describe("resolution — phase transitions (docs/06)", () => {
  let rEnv: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    rEnv = makeEnv({
      status: {
        sessions: {
          "s-1": {
            status: "open",
            kind: "peer",
            cwd: "/tmp",
            title: "tilt",
            model: "m",
            phase: "working",
            log: "logs/s-1.jsonl",
            toolCounts: {},
            turns: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastActivity: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });
  });

  it("waiting → working on the next tool activity resolves the open item", async () => {
    const w = startWatcher(baseOpts(rEnv));
    await w.start();
    rEnv.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "permission request: deploy canary" }) });
    await tick(rEnv);
    expect(rEnv.statusFile.sessions["s-1"]!.phase).toBe("waiting");
    expect(rEnv.attention.filter((i) => i.resolvedAt === undefined)).toHaveLength(1);

    // tool proceeds (any approval-shaped next activity re-classifies working)
    rEnv.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "kubectl rollout status" }) });
    await tick(rEnv);
    expect(rEnv.statusFile.sessions["s-1"]!.phase).toBe("working");
    expect(rEnv.attention.every((i) => i.resolvedAt !== undefined)).toBe(true);
  });

  it("blocked → working on the next assistant activity resolves the blocked item", async () => {
    const w = startWatcher(baseOpts(rEnv));
    await w.start();
    rEnv.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "fatal: cannot connect to the registry" }) });
    await tick(rEnv);
    expect(rEnv.statusFile.sessions["s-1"]!.phase).toBe("blocked");
    expect(rEnv.attention.filter((i) => i.resolvedAt === undefined)).toHaveLength(1);

    rEnv.publish({ topic: "log", payload: logEntry({ kind: "assistant_message", text: "recovered, deploying again" }) });
    await tick(rEnv);
    expect(rEnv.statusFile.sessions["s-1"]!.phase).toBe("working");
    expect(rEnv.attention.every((i) => i.resolvedAt !== undefined)).toBe(true);
  });

  it("working → working with no open item resolves nothing (no phantom resolves)", async () => {
    const w = startWatcher(baseOpts(rEnv));
    await w.start();
    rEnv.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "bun test" }) });
    await tick(rEnv);
    expect(rEnv.statusFile.sessions["s-1"]!.phase).toBe("working");
    expect(rEnv.attention).toHaveLength(0);
  });

  it("stop() unsubscribes from the bus (docs/01: stop releases the subscription)", async () => {
    const w = startWatcher(baseOpts(rEnv));
    await w.start();
    expect(rEnv.handlerCount()).toBe(1);

    w.stop();
    expect(rEnv.handlerCount()).toBe(0);

    // late events after stop: no processing at all
    rEnv.publish({ topic: "log", payload: logEntry({ kind: "tool_call", text: "permission request: after stop" }) });
    await tick(rEnv);
    expect(rEnv.statusFile.sessions["s-1"]!.phase).toBe("working");
    expect(rEnv.attention).toHaveLength(0);
  });
});
