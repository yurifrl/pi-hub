// extensions/hub.test.ts — the extension contract with a stubbed host context
// (docs/01 §Testing: "extensions/hub.ts … exercised through the reporter/tool
// contract with a stubbed host context; no omp runtime needed").
//
// Covers the tk-hai acceptance flows:
//  1. factory guard: OMP_HUB_BRAIN=1 → zero registrations (anti-recursion 1)
//  2. /hub-start → socket bound + brain child spawned through the injectable
//     AgentRuntime fake (no real omp), widget key claimed
//  3. /hub-stop → socket closed + children terminated + session still alive
//  4. /hub-agent toggling (spawn + adopt + stop; acp flavor env)
//  5. env resolution boundary (injected, never read inside lib)
//  6. socket serving asserted through frames + replay, not sleeps
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import hubFactory, { WIDGET_KEY, createHubCommands, buildAgentSpec, createHubExtension } from "./hub";
import type { WidgetController } from "./widget";
import { resolveHubEnv } from "./hub_env";
import { createHubLocal, reportToRaw } from "./hub_local";
import type { HubLocal } from "./hub_local";
import type { HubEnv } from "./hub_env";
import type { Result, HubError, AgentRuntime, AgentHandle } from "@yurifrl/hub";
import type { HubSocketServer } from "@yurifrl/hub/adapters/unix_socket";
import type { StatusFile } from "@yurifrl/hub";

// ---- stub ExtensionAPI (records registrations; docs/01 "stubbed host context") ----

type Registration = { kind: "command"; name: string } | { kind: "event"; event: string };

const makePi = () => {
    const registrations: Registration[] = [];
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    /** registration-ORDERED event handlers — pi dispatches same-extension
     * handlers in registration order with ONE shared ctx (the Map above is
     * last-wins and masked that; the tk-epx P0 hid here) */
    const eventLog: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
    const widgets = new Map<string, string[] | undefined>();
    const pi = {
        registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
            registrations.push({ kind: "command", name });
            commands.set(name, opts.handler);
        },
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
            registrations.push({ kind: "event", event });
            eventLog.push({ event, handler });
            events.set(event, handler);
        },
        registerTool: () => {
            registrations.push({ kind: "event", event: "tool" });
        },
        ui: {
            setWidget: (key: string, content: string[] | ((t: never, theme: never) => { render(w: number): string[] }) | undefined, _opts?: unknown) => {
                widgets.set(key, typeof content === "function" ? content(undefined as never, undefined as never).render(200).map((l) => l.replace(/\s+$/, "")) : content);
            },
        },
    };
    return {
        pi,
        registrations,
        commands,
        events,
        eventLog,
        widgets,
        /** fire an event through ALL registered handlers in pi's real
         * dispatch order (registration order, one shared ctx) */
        dispatch: (event: string, payload: unknown, ctx: unknown) => {
            for (const h of eventLog) {
                if (h.event === event) h.handler(payload, ctx);
            }
        },
        /** the FIRST handler registered for an event (order-observable) */
        firstHandler: (event: string) => eventLog.find((h) => h.event === event)?.handler,
    };
};

// ---- fake AgentRuntime (no real omp; acceptance #2) ----

type SpawnRecord = { name?: string; model?: string };

const makeRuntime = () => {
    const spawns: SpawnRecord[] = [];
    const killed: string[] = [];
    let seq = 0;
    const live = new Map<string, AgentHandle>();
    const runtime: AgentRuntime = {
        spawn: async (spec) => {
            spawns.push(spec);
            const name = spec.name ?? `worker-${++seq}`;
            const handle: AgentHandle = { name, sessionId: null, ...(spec.model !== undefined ? { model: spec.model } : {}) };
            live.set(name, handle);
            return { ok: true, value: handle };
        },
        send: async () => ({ ok: true, value: undefined }) as Result<void, HubError>,
        kill: async (name) => {
            killed.push(name);
            live.delete(name);
            return { ok: true, value: undefined } as Result<void, HubError>;
        },
    };
    return { runtime, spawns, killed, live };
};

// ---- fake socket server: records frames, hands them to a replayable pump ----

const makeSocketFake = () => {
    const served: Array<{ frame: unknown; conn: FakeConn }> = [];
    const started: string[] = [];
    let closeCount = 0;
    const conns: FakeConn[] = [];

    class FakeConn {
        delivered: Array<{ sessionId: string; text: string }> = [];
        /** sessions this connection owns (session_start reported through it) */
        sessions = new Set<string>();
        constructor(public client: string | undefined) {
            conns.push(this);
        }
    }

    const server = {
        start: async (path?: string) => {
            started.push(path ?? "");
            return { ok: true, value: { socketPath: path ?? "" } } as Result<{ socketPath: string }, HubError>;
        },
        close: async () => {
            closeCount++;
            return Promise.resolve();
        },
        broadcast: (frame: unknown) => {
            served.push({ frame, conn: conns[conns.length - 1] ?? new FakeConn(undefined) });
        },
        deliverTo: (sessionId: string, text: string) => {
            // sessionId-addressed parity with the real server: route by the
            // connection that reported session_start for this session
            const owner = conns.find((c) => c.sessions.has(sessionId));
            const conn = owner ?? (conns.length === 1 ? conns[0] : undefined);
            if (!conn) return { ok: false, error: { code: "unknown-session", message: `no reporter owns ${sessionId}`, retryable: false } } as Result<void, HubError>;
            conn.delivered.push({ sessionId, text });
            return { ok: true, value: undefined } as Result<void, HubError>;
        },
    };
    const factory = (opts: Record<string, unknown>) => {
        (server as unknown as { __opts: Record<string, unknown> }).__opts = opts;
        return server;
    };
    return { server, factory, served, started, closeCount: () => closeCount, conns };
};

// ---- fake watcher runtime: start/stop/spawnAgent spies (tk-jwx seam) ----

const makeWatcherFake = () => {
    const calls = { start: 0, stop: 0, spawn: 0 };
    const runtime: import("@yurifrl/hub/runtime/watcher").WatcherRuntime = {
        start: async () => {
            calls.start++;
        },
        stop: () => {
            calls.stop++;
        },
        spawnAgent: async () => {
            calls.spawn++;
            return { ok: true, value: { name: "hub-watcher" } } as Result<{ name: string }, HubError>;
        },
        state: () => ({ agentSessionId: null, selfIds: [], restarts: 0, running: calls.start > calls.stop }),
    };
    return { runtime, calls };
};

// ---- env + temp dirs ----

const tmps: string[] = [];
const makeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-ext-"));
    tmps.push(dir);
    return dir;
};
afterEach(async () => {
    for (const dir of tmps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeEnv = async (overrides: Partial<Record<string, string>> = {}): Promise<{ env: HubEnv; root: string; sockPath: string }> => {
    const root = await makeRoot();
    const sockPath = join(root, "hub.sock");
    const env = resolveHubEnv({
        OMP_HUB_SOCK: sockPath,
        OMP_BIN: "omp-fake",
        ...overrides,
    });
    return { env, root, sockPath };
};

// =====================================================================
// 1. Factory guard (acceptance #1)
// =====================================================================

describe("hub factory — brain guard (docs/05 §Anti-recursion guard 1)", () => {
    it("OMP_HUB_BRAIN=1 → factory registers NOTHING (zero pi.on/registerTool/registerCommand)", async () => {
        const { pi, registrations } = makePi();
        const prev = process.env.OMP_HUB_BRAIN;
        process.env.OMP_HUB_BRAIN = "1";
        try {
            hubFactory(pi as never);
            expect(registrations).toEqual([]);
        } finally {
            if (prev === undefined) delete process.env.OMP_HUB_BRAIN;
            else process.env.OMP_HUB_BRAIN = prev;
        }
    });

    it("without the guard env, the factory registers the three commands + lifecycle events", async () => {
        const { env } = await makeEnv();
        const { pi, registrations } = makePi();
        process.env.OMP_HUB_SOCK = env.sock;
        try {
            hubFactory(pi as never);
            const names = registrations.filter((r) => r.kind === "command").map((r) => (r as { name: string }).name);
            expect(names).toContain("hub-start");
            expect(names).toContain("hub-stop");
            expect(names).toContain("hub-agent");
            expect(registrations.length).toBeGreaterThan(0);
        } finally {
            delete process.env.OMP_HUB_SOCK;
        }
    });
});

// =====================================================================
// 2. /hub-start (acceptance #2, #6)
// =====================================================================

describe("createHubCommands.hubStart — socket bound + brain spawned via injectable runtime", () => {
    it("binds the socket at env.sock, spawns the brain through the injected fake runtime (no real omp)", async () => {
        const { env, sockPath } = await makeEnv();
        const rt = makeRuntime();
        const local = createHubLocal({
            env,
            selfSessionId: () => "s-self",
            overrides: { runtime: rt.runtime, socket: makeSocketFake().factory as never },
        });
        const out = await local.start();
        expect(out.ok).toBe(true);
        // socket bound at the resolved path
        expect(out.ok && out.value.socketPath).toBe(sockPath);
        // brain child spawned with the docs/05 name through the FAKE runtime
        expect(rt.spawns.length).toBe(1);
        expect(rt.spawns[0]!.name).toBe("brain");
        await local.stop();
    });

    it("real unix socket: reporter frame in → reply frame out (frames, not sleeps)", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        const local: HubLocal = createHubLocal({ env, selfSessionId: () => "s-self", overrides: { runtime: rt.runtime } });
        const started = await local.start();
        expect(started.ok).toBe(true);
        // connect a raw client, hello, then one cmd; assert the reply frame
        const frames: Record<string, unknown>[] = [];
        let resolveReply: () => void = () => {};
        const gotReply = new Promise<void>((r) => {
            resolveReply = r;
        });
        const sock = net.createConnection(env.sock);
        let buffer = "";
        sock.on("connect", () => {
            sock.write(JSON.stringify({ v: 1, ch: "hello", client: "cli" }) + "\n");
            sock.write(JSON.stringify({ v: 1, ch: "cmd", cmdId: "c1", op: "list", args: {} }) + "\n");
        });
        sock.on("data", (buf: Buffer) => {
            buffer += buf.toString("utf8");
            for (;;) {
                const nl = buffer.indexOf("\n");
                if (nl < 0) break;
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                const parsed = JSON.parse(line) as Record<string, unknown>;
                frames.push(parsed);
                if (parsed.ch === "reply") resolveReply();
            }
        });
        await gotReply;
        sock.destroy();
        const reply = frames.find((f) => f.ch === "reply") as { cmdId: string; ok: boolean } | undefined;
        expect(reply).toBeDefined();
        expect(reply!.cmdId).toBe("c1");
        expect(reply!.ok).toBe(true);
        await local.stop();
    });

    it("report frames land in status.json through the normalize pipeline", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        const local = createHubLocal({ env, selfSessionId: () => "s-self", overrides: { runtime: rt.runtime } });
        await local.start();
        const client = await connectClient(env.sock);
        client.report("session_start", { sessionId: "s-abc", attached: false, cwd: "/tmp/x" });
        // poll for the roster row — fixed sleep raced under load
        for (let i = 0; i < 100; i++) {
            const s = await local.readStatus();
            if (s.ok && s.value.sessions["s-abc"]) break;
            await Bun.sleep(2);
        }
        const snap = await local.readStatus();
        expect(snap.ok).toBe(true);
        if (snap.ok) expect(snap.value.sessions["s-abc"]).toBeDefined();
        client.close();
        await local.stop();
    });

    it("/hub-start STARTS the watcher: bus subscription + supervision live (P1-1)", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        const wf = makeWatcherFake();
        const local = createHubLocal({
            env,
            selfSessionId: () => "s-self",
            overrides: {
                runtime: rt.runtime,
                socket: makeSocketFake().factory as never,
                watcher: () => {
                    return wf.runtime;
                },
            },
        });
        const out = await local.start();
        expect(out.ok).toBe(true);
        // startWatcher.start() invoked on /hub-start (was never called pre-fix)
        expect(wf.calls.start).toBe(1);
        expect(local.watcher).toBe(wf.runtime);
        await local.stop();
        // and STOPPED on /hub-stop
        expect(wf.calls.stop).toBe(1);
        expect(local.watcher).toBeNull();
    });

    it("/hub-start composes the watcher with the acp agent runtime (not the rpc brain runtime)", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        const art = makeRuntime();
        let seen: unknown = null;
        const local = createHubLocal({
            env,
            selfSessionId: () => "s-self",
            overrides: {
                runtime: rt.runtime,
                agentRuntime: art.runtime,
                socket: makeSocketFake().factory as never,
                watcher: (composed) => {
                    seen = composed.runtime;
                    return makeWatcherFake().runtime;
                },
            },
        });
        await local.start();
        expect(seen).toBe(art.runtime);
        expect(seen).not.toBe(rt.runtime);
        await local.stop();
    });
});

// =====================================================================
// 3. /hub-stop (acceptance #3)
// =====================================================================

describe("createHubCommands.hubStop — socket closed + children terminated + session alive", () => {
    it("kills spawned children and closes the socket; the host session object is untouched", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        const fake = makeSocketFake();
        const state = { active: false, local: null as HubLocal | null, selfSessionId: "s-self", agentActive: false, agentName: null as string | null, widget: null as WidgetController | null };
        const local = createHubLocal({ env, selfSessionId: () => state.selfSessionId, overrides: { runtime: rt.runtime, socket: fake.factory as never } });
        state.local = local;
        const commands = createHubCommands(env, state, () => rt.runtime, () => local);

        const startOut = await commands.hubStart();
        expect(startOut.ok).toBe(true);
        expect(rt.spawns.length).toBe(1); // brain

        const stopOut = await commands.hubStop();
        expect(stopOut.ok).toBe(true);
        // children terminated through the runtime (docs/05 §Shutdown step 3)
        expect(rt.killed).toContain("brain");
        // socket closed (docs/05 §Shutdown step 2)
        expect(fake.closeCount()).toBe(1);
        // session still alive: state reset, nothing threw, selfSessionId intact
        expect(state.active).toBe(false);
        expect(state.selfSessionId).toBe("s-self");
    });

    it("open peer sessions are NOT archived on hub stop (docs/05 §Shutdown)", async () => {
        const { env, root } = await makeEnv();
        const rt = makeRuntime();
        const state = { active: false, local: null as HubLocal | null, selfSessionId: "s-self", agentActive: false, agentName: null as string | null, widget: null as WidgetController | null };
        const local = createHubLocal({ env, selfSessionId: () => state.selfSessionId, overrides: { runtime: rt.runtime } });
        state.local = local;
        const commands = createHubCommands(env, state);
        await commands.hubStart();

        // a peer announces itself, then the hub stops
        const client = await connectClient(env.sock);
        client.report("session_start", { sessionId: "s-peer", attached: false, cwd: "/tmp/x" });
        // poll for the roster row — fixed sleep raced under load
        for (let i = 0; i < 100; i++) {
            const s = await local.readStatus();
            if (s.ok && s.value.sessions["s-peer"]) break;
            await Bun.sleep(2);
        }
        client.close();
        await commands.hubStop();

        const snap = await local.readStatus();
        if (snap.ok) {
            // the peer row survives the hub stop — sessions outlive the hub
            expect(snap.value.sessions["s-peer"]).toBeDefined();
        }
        // no archive tree was written (no archive/<YYYY-MM>/ dir)
        let archiveMissing = false;
        try {
            await stat(join(root, "archive"));
        } catch {
            archiveMissing = true;
        }
        expect(archiveMissing).toBe(true);
    });
});

// =====================================================================
// 4. /hub-agent toggling (acceptance #4)
// =====================================================================

describe("createHubCommands.hubAgent — toggle the hub agent surface", () => {
    it("spawns the acp agent via the injected acp runtime (flavor+env asserted); second call adopts (no double spawn)", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime(); // the rpc (brain) runtime — must NOT see the agent spawn
        const art = makeRuntime(); // the acp (agent) runtime — the /hub-agent path
        const state = { active: false, local: null as HubLocal | null, selfSessionId: "s-self", agentActive: false, agentName: null as string | null, widget: null as WidgetController | null };
        const theLocal = createHubLocal({
            env,
            selfSessionId: () => state.selfSessionId,
            // REAL watcher (spawnOnStart:false): /hub-agent must route through
            // watcherSpawn() → the supervised path → the acp runtime. A fake
            // watcher here would swallow the spawn and re-hide the P1-2 misroute.
            overrides: { runtime: rt.runtime, agentRuntime: art.runtime, socket: makeSocketFake().factory as never },
        });
        state.local = theLocal;
        const commands = createHubCommands(env, state, () => art.runtime, () => theLocal);
        await commands.hubStart();

        const on = await commands.hubAgent();
        expect(on.ok).toBe(true);
        expect(state.agentActive).toBe(true);
        expect(state.agentName).toBe("hub-watcher");
        // P1-2 regression: the spawn went through the acp runtime, flavor- and
        // env-correct (the OLD test passed a name-only fake and missed the
        // rpc misroute); the brain runtime saw nothing
        expect(art.spawns.length).toBe(1);
        expect(art.spawns[0]!.name).toBe("hub-watcher");
        expect(art.spawns[0]!.model).toBeUndefined();
        expect(rt.spawns.length).toBe(1); // only the brain
        expect(rt.spawns[0]!.name).toBe("brain");
        const agentSpawnsAfterOn = art.spawns.length;

        // adopt: at most one hub agent (docs/05 §Agent spawn)
        const again = await commands.hubAgent();
        expect(again.ok).toBe(true);
        expect(art.spawns.length).toBe(agentSpawnsAfterOn);

        // /hub-stop kills the agent child (P2-1: was reset-without-kill)
        await commands.hubStop();
        expect(art.killed).toContain("hub-watcher");
        expect(state.agentActive).toBe(false);
        expect(state.agentName).toBeNull();

        // re-start spawns fresh: a second /hub-agent spawns a NEW child, not a zombie
        const start2 = await commands.hubStart();
        expect(start2.ok).toBe(true);
        const on2 = await commands.hubAgent();
        expect(on2.ok).toBe(true);
        expect(art.spawns.length).toBe(2);
        expect(art.spawns[1]!.name).toBe("hub-watcher");
        await commands.hubStop();
    });

    it("/hub-stop with a running agent terminates the child and re-start re-spawns fresh (P2-1)", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime(); // the rpc (brain) runtime fake
        const art = makeRuntime(); // the acp (agent) runtime fake
        const state = { active: false, local: null as HubLocal | null, selfSessionId: "s-self", agentActive: false, agentName: null as string | null, widget: null as WidgetController | null };
        const theLocal = createHubLocal({
            env,
            selfSessionId: () => state.selfSessionId,
            // REAL watcher again: spawn assertion must prove the acp runtime
            // got the spawn through the watcher's supervised path (P1-2).
            overrides: { runtime: rt.runtime, agentRuntime: art.runtime, socket: makeSocketFake().factory as never },
        });
        state.local = theLocal;
        const commands = createHubCommands(env, state, () => art.runtime, () => theLocal);
        await commands.hubStart();
        expect((await commands.hubAgent()).ok).toBe(true);
        expect(art.spawns.length).toBe(1);

        await commands.hubStop();
        expect(art.killed).toContain("hub-watcher");
        expect(state.agentActive).toBe(false);
        expect(state.agentName).toBeNull();

        // re-start + re-toggle spawns a fresh child (no orphan, no double)
        await commands.hubStart();
        expect((await commands.hubAgent()).ok).toBe(true);
        expect(art.spawns.length).toBe(2);
        await commands.hubStop();
        expect(art.killed).toEqual(["hub-watcher", "hub-watcher"]);
    });

    it("guard 5: /hub-start inside a hub-agent session is refused (mutation check: guard removal must fail this test)", async () => {
        // P2-3: the guard-5 mutation survived because nothing exercised the
        // refusal through the command surface.
        const { env } = await makeEnv({ OMP_HUB_AGENT: "1" });
        const rt = makeRuntime();
        const state = { active: false, local: null as HubLocal | null, selfSessionId: "s-self", agentActive: false, agentName: null as string | null, widget: null as WidgetController | null };
        let composed = 0;
        const commands = createHubCommands(env, state, () => rt.runtime, () => {
            composed++;
            return state.local!;
        });
        const out = await commands.hubStart();
        expect(out.ok).toBe(false);
        expect(out.text).toBe("this session is the hub agent");
        // refused BEFORE any composition/start side effects
        expect(composed).toBe(0);
        expect(state.active).toBe(false);
        expect(state.local).toBeNull();
    });

    it("hub-agent before hub-start is refused (hub not active)", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        const state = { active: false, local: null as HubLocal | null, selfSessionId: "s-self", agentActive: false, agentName: null as string | null, widget: null as WidgetController | null };
        const commands = createHubCommands(env, state);
        const out = await commands.hubAgent();
        expect(out.ok).toBe(false);
        expect(rt.spawns.length).toBe(0);
    });

    it("buildAgentSpec: acp mode + OMP_HUB_AGENT=1 env + guard 5 refuses inside the agent", async () => {
        const { env } = await makeEnv({ OMP_HUB_MODEL: "aihub/glm-5.3-flash" });
        const spec = buildAgentSpec(env);
        expect(spec).toEqual({
            name: "hub-watcher",
            bin: "omp-fake",
            args: ["--mode", "acp"],
            env: { OMP_HUB_AGENT: "1", OMP_HUB_MODEL: "aihub/glm-5.3-flash" },
        });
        const agentEnv = resolveHubEnv({ OMP_HUB_AGENT: "1" });
        const refused = buildAgentSpec(agentEnv);
        expect("error" in refused && refused.error.code).toBe("denied");
    });
});

// =====================================================================
// 5. env resolution boundary (acceptance #5)
// =====================================================================

describe("hub_env — resolution happens at the extension boundary", () => {
    it("defaults: sock ~/.hub/hub.sock, bin omp, dataRoot beside the socket", () => {
        const e = resolveHubEnv({});
        expect(e.sock.endsWith(".hub/hub.sock") || e.sock.endsWith(".hub\\hub.sock")).toBe(true);
        expect(e.ompBin).toBe("omp");
        expect(e.brain).toBe(false);
        expect(e.hubAgent).toBe(false);
        expect(e.dataRoot.endsWith(".hub") || e.dataRoot.endsWith(".hub\\")).toBe(true);
    });

    it("overrides flow through; OMP_HUB_BRAIN / OMP_HUB_AGENT parse only '1'", async () => {
        const e = resolveHubEnv({ OMP_HUB_SOCK: "/tmp/x/h.sock", OMP_BIN: "/opt/omp", OMP_HUB_BRAIN: "1", OMP_HUB_AGENT: "on", OMP_HUB_MODEL: "m1" });
        expect(e.sock).toBe("/tmp/x/h.sock");
        expect(e.dataRoot).toBe("/tmp/x");
        expect(e.ompBin).toBe("/opt/omp");
        expect(e.brain).toBe(true);
        expect(e.hubAgent).toBe(false); // only "1" counts
        expect(e.model).toBe("m1");
    });

    it("lib stays env-free: createHubLocal takes HubEnv, never reads process.env", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        // prove the point: wipe the vars from process.env before composing —
        // the local stack still uses the injected values
        const prevSock = process.env.OMP_HUB_SOCK;
        delete process.env.OMP_HUB_SOCK;
        try {
            const local = createHubLocal({ env, selfSessionId: () => "s-self", overrides: { runtime: rt.runtime, socket: makeSocketFake().factory as never } });
            const out = await local.start();
            expect(out.ok).toBe(true);
            expect(out.ok && out.value.socketPath).toBe(env.sock);
            await local.stop();
        } finally {
            if (prevSock !== undefined) process.env.OMP_HUB_SOCK = prevSock;
        }
    });
});

// =====================================================================
// 5b. agent op over the socket (tk-hai acceptance: cmd frame agent {} →
//     the watcher's supervised spawn path → reply { started, name })
// =====================================================================

describe("agent op over the unix socket", () => {
    it("cmd frame agent {} routes through the watcher's supervised path; second call adopts (no double spawn)", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime(); // brain — must see only its own spawn
        const art = makeRuntime(); // acp (agent) runtime — the agent op path
        const local = createHubLocal({
            env,
            selfSessionId: () => "s-self",
            // REAL watcher: adopt semantics (childName !== null) live in
            // startWatcher, not in the op — a fake here would count two spawns
            overrides: { runtime: rt.runtime, agentRuntime: art.runtime },
        });
        const started = await local.start();
        expect(started.ok).toBe(true);

        const client = await connectClient(env.sock);
        const reply = await client.cmd("agent");
        expect(reply.ok).toBe(true);
        if (reply.ok) {
            expect(reply.value).toMatchObject({ started: true, name: "hub-watcher" });
        }
        expect(art.spawns.length).toBe(1); // supervised path, not a raw spawn
        expect(rt.spawns.length).toBe(1); // brain untouched

        // second call adopts: still one spawn (docs/05 §Agent spawn)
        const again = await client.cmd("agent");
        expect(again.ok).toBe(true);
        expect(art.spawns.length).toBe(1);

        client.close();
        await local.stop();
    });
});

// =====================================================================
// 6. reporter frame translation + widget key contract
// =====================================================================

describe("reportToRaw + widget key", () => {
    it("translates docs/02 reporter frames into RawOmpEvents; unknown frames dropped", () => {
        expect(reportToRaw({ v: 1, ch: "report", frame: "session_start", sessionId: "s1", attached: true, cwd: "/w" })).toEqual({
            type: "session_start",
            sessionId: "s1",
            attached: true,
            cwd: "/w",
        });
        expect(reportToRaw({ v: 1, ch: "report", frame: "tool_call", sessionId: "s1", tool: "bash", args: { command: "ls" } })).toEqual({
            type: "tool_call",
            sessionId: "s1",
            tool: "bash",
            args: { command: "ls" },
        });
        expect(reportToRaw({ v: 1, ch: "report", frame: "mystery", sessionId: "s1" })).toBeNull();
        expect(reportToRaw({ v: 1, ch: "report", frame: "user_message" })).toBeNull(); // no sessionId
    });

    it("P2-4: session_start title/model pass through into the RawOmpEvent (roster rows titled)", () => {
        expect(
            reportToRaw({ v: 1, ch: "report", frame: "session_start", sessionId: "s1", attached: false, cwd: "/w", title: "refactor hub", model: "aihub/glm-5.3-flash" }),
        ).toEqual({
            type: "session_start",
            sessionId: "s1",
            attached: false,
            cwd: "/w",
            title: "refactor hub",
            model: "aihub/glm-5.3-flash",
        });
        // absent/empty title+model are omitted (exactOptionalPropertyTypes-safe)
        expect(
            reportToRaw({ v: 1, ch: "report", frame: "session_start", sessionId: "s2", attached: false, cwd: "/w" }),
        ).toEqual({ type: "session_start", sessionId: "s2", attached: false, cwd: "/w" });
        expect(
            reportToRaw({ v: 1, ch: "report", frame: "session_start", sessionId: "s3", attached: false, cwd: "/w", title: "", model: "" }),
        ).toEqual({ type: "session_start", sessionId: "s3", attached: false, cwd: "/w" });
    });

    it("P2-4 end-to-end: a session_start frame with title lands in status.json sessions row", async () => {
        const { env } = await makeEnv();
        const rt = makeRuntime();
        const local = createHubLocal({ env, selfSessionId: () => "s-self", overrides: { runtime: rt.runtime } });
        await local.start();
        const client = await connectClient(env.sock);
        client.report("session_start", { sessionId: "s-titled", attached: false, cwd: "/tmp/x", title: "deploy canary", model: "m-1" });
        // poll instead of a fixed sleep: the report pipeline is async and the
        // 5ms sleep raced under load (flaked in full-suite runs)
        for (let i = 0; i < 100; i++) {
            const snap = await local.readStatus();
            if (snap.ok && snap.value.sessions["s-titled"]) break;
            await Bun.sleep(2);
        }
        const snap = await local.readStatus();
        expect(snap.ok).toBe(true);
        if (snap.ok) {
            expect(snap.value.sessions["s-titled"]!.title).toBe("deploy canary");
            expect(snap.value.sessions["s-titled"]!.model).toBe("m-1");
        }
        client.close();
        await local.stop();
    });

    it("widget key is the stable omp contract", () => {
        expect(WIDGET_KEY).toBe("omp-hub-stream");
    });

    it("factory session_start handler claims the widget slot via ctx.ui.setWidget", async () => {
        const { env } = await makeEnv();
        const { pi, widgets, firstHandler } = makePi();
        process.env.OMP_HUB_SOCK = env.sock;
        try {
            hubFactory(pi as never);
            // the ctx-capture handler is the FIRST session_start handler
            // registered (tk-epx P0: order matters); the Map is last-wins
            const handler = firstHandler("session_start");
            expect(handler).toBeDefined();
            const ctx = { ui: { setWidget: (key: string, content: string[] | ((t: never, theme: never) => { render(w: number): string[] }) | undefined, _opts?: unknown) => widgets.set(key, typeof content === "function" ? content(undefined as never, undefined as never).render(200).map((l) => l.replace(/\s+$/, "")) : content) } };
            handler!({}, ctx);
            expect(widgets.get(WIDGET_KEY)).toEqual(["hub idle — /hub-start to serve"]);
        } finally {
            delete process.env.OMP_HUB_SOCK;
        }
    });
});

// =====================================================================
// 7. registration-order regression (tk-epx P0)
// =====================================================================
// pi dispatches same-extension handlers in REGISTRATION ORDER with ONE shared
// ExtensionContext, and SessionStartEvent carries no sessionId — session
// identity is only reachable via ctx. The factory must therefore register the
// lastCtx-assignment handler BEFORE reporter.register(pi), so the reporter's
// session_start handler reads a ctx that is already captured.

describe("registration order — ctx capture precedes the reporter (tk-epx P0)", () => {
    const makeWiredEnv = async () => {
        const { env } = await makeEnv();
        process.env.OMP_HUB_SOCK = env.sock;
        return env;
    };

    it("the ctx-capture session_start handler is registered BEFORE the reporter's (order observable)", async () => {
        const env = await makeWiredEnv();
        try {
            const { pi, eventLog } = makePi();
            hubFactory(pi as never);
            const sessionStartEvents = eventLog.filter((h) => h.event === "session_start");
            expect(sessionStartEvents.length).toBeGreaterThanOrEqual(2);
            // Identify each handler by its side effect: the factory's ctx-capture
            // handler paints the idle widget; the reporter's session_start handler
            // never touches the widget (it may even throw on a bare ctx — that
            // throw is the P0 bug itself, recorded as silent).
            const widgetPaints: boolean[] = sessionStartEvents.map((h) => {
                const seen: Array<string[] | undefined> = [];
                try {
                    h.handler({}, { ui: { setWidget: (_k: string, c: string[] | undefined) => seen.push(c) } });
                } catch {
                    /* the reporter reading a bare ctx — fine for this probe */
                }
                return seen.length > 0;
            });
            // handler[0] = capture (paints), handler[1] = reporter (silent).
            // Pre-fix this was reversed → the reporter read lastCtx undefined.
            expect(widgetPaints[0]).toBe(true);
            expect(widgetPaints[1]).toBe(false);
            void env;
        } finally {
            delete process.env.OMP_HUB_SOCK;
        }
    });

    /** hermetic wiring: injectable connect seam through createHubExtension */
    const makeWired = async () => {
        const env = await makeWiredEnv();
        const fake = makeFakeHubClient();
        let connectCalls = 0;
        const factory = createHubExtension({
            connect: async () => {
                connectCalls++;
                return { ok: true as const, client: fake.client };
            },
        });
        return { env, fake, factory, countConnect: () => connectCalls };
    };

    it("first session_start (the ONLY one a real process gets) produces the connect attempt with correct sessionId/title/cwd/model", async () => {
        const { fake, factory, countConnect } = await makeWired();
        try {
            const { pi, dispatch } = makePi();
            factory(pi as never);
            // the ONE session_start a fresh process receives — one shared ctx
            const ctx = {
                sessionManager: {
                    getSessionId: () => "s-first",
                    getSessionName: () => "orders matter",
                },
                cwd: "/work/first",
                model: { id: "aihub/glm-5.3-flash" },
                ui: { setWidget: () => {} },
            };
            dispatch("session_start", {} as never, ctx);
            // let the fire-and-forget open() run
            await Bun.sleep(50);

            // the reporter connected (first session_start already carries identity)
            expect(countConnect()).toBe(1);
            // attach-on-connect announced the session with the ctx facts
            const attach = fake.reports.find((r) => r.frame === "session_start" && (r.payload as { attached?: boolean }).attached === true);
            expect(attach).toBeDefined();
            expect((attach!.payload as { sessionId: string }).sessionId).toBe("s-first");
            expect((attach!.payload as { title?: string }).title).toBe("orders matter");
            expect((attach!.payload as { cwd: string }).cwd).toBe("/work/first");
            expect((attach!.payload as { model: string }).model).toBe("aihub/glm-5.3-flash");
            // and the local-announcement frame (attached:false) is ALSO correct
            const local = fake.reports.find((r) => r.frame === "session_start" && (r.payload as { attached?: boolean }).attached === false);
            expect(local).toBeDefined();
            expect((local!.payload as { sessionId: string }).sessionId).toBe("s-first");
        } finally {
            delete process.env.OMP_HUB_SOCK;
        }
    });

    it("REVERSED order (the pre-fix bug): reporter runs first → sessionId is empty → 0 connects, no frames", async () => {
        // The validator's empirical repro, encoded: with the reporter's
        // session_start handler running BEFORE ctx capture (the committed
        // pre-fix order), sessionFacts reads lastCtx === undefined → facts
        // sessionId "" → open() early-returns, no connect, only empty-session
        // frames queued. A real process never gets a second session_start.
        const { fake, factory, countConnect } = await makeWired();
        try {
            const { pi, eventLog } = makePi();
            factory(pi as never);
            const ctx = {
                sessionManager: { getSessionId: () => "s-rev", getSessionName: () => "rev" },
                cwd: "/work/rev",
                model: { id: "m-rev" },
                ui: { setWidget: () => {} },
            };
            // dispatch in REVERSE registration order — the pre-fix behavior
            for (const h of [...eventLog].reverse()) {
                if (h.event === "session_start") h.handler({} as never, ctx);
            }
            await Bun.sleep(50);
            // reporter saw lastCtx undefined → sessionId "" → never connected
            expect(countConnect()).toBe(0);
            expect(fake.reports).toEqual([]);
        } finally {
            delete process.env.OMP_HUB_SOCK;
        }
    });
});

// =====================================================================
// 8. guard-2 self-feed through the REAL factory wiring (tk-l4a)
// =====================================================================
// Pre-tk-l4a, state.selfSessionId was initialized "" in the factory closure
// and never written: the reporter's self-feed decision (sessionId ===
// selfSessionId → local handleReport, zero socket frames — docs/05
// §Anti-recursion guard 2) could never fire in real wiring; the reporter's
// own unit tests passed only because they injected the id directly. These
// tests run createHubExtension through makePi's ORDERED dispatch: one
// session_start with a real-ish ctx (the only one a real process gets), then
// reporter frames. Mutation check: delete the state.selfSessionId write in
// hub.ts's session_start handler → the self-feed test below FAILS.

describe("guard-2 self-feed — factory writes state.selfSessionId at ctx capture (tk-l4a)", () => {
    const makeSelfWired = async () => {
        const { env } = await makeEnv();
        process.env.OMP_HUB_SOCK = env.sock;
        const fake = makeFakeHubClient();
        const factory = createHubExtension({
            connect: async () => ({ ok: true as const, client: fake.client }),
        });
        return { env, fake, factory };
    };

    const makeSelfCtx = (id: string) => ({
        sessionManager: { getSessionId: () => id, getSessionName: () => "self" },
        cwd: "/work/self",
        model: { id: "m-self" },
        ui: { setWidget: () => {} },
    });

    it("sessionId === selfSessionId → guard-2: frame lands in the hub, ZERO socket frames", async () => {
        const { env, fake, factory } = await makeSelfWired();
        try {
            const { pi, commands: cmdMap, dispatch } = makePi();
            factory(pi as never);
            // /hub-start through the command surface: the REAL wiring, not a
            // hand-built state — compose() defaults to createHubLocal with
            // selfSessionId: () => state.selfSessionId (the tk-hai seam)
            const startCmd = cmdMap.get("hub-start")!;
            await startCmd("", { ui: { notify: () => {}, setWidget: () => {} } });
            // the ordered dispatch: the capture handler writes
            // state.selfSessionId BEFORE the reporter's session_start runs
            dispatch("session_start", {} as never, makeSelfCtx("s-self-1"));
            await Bun.sleep(50);

            // POSITIVE: the self frame reached the local hub (roster row), so
            // guard-2 delivered it through handleReport, not the outbox
            await waitFor(async () => {
                const snap = await listStatus(env.sock);
                return Object.keys(snap.sessions).includes("s-self-1");
            });
            // NEGATIVE (mutation check): the self frame never touched the
            // socket — deleting the state.selfSessionId write fails the
            // roster assertion above (frame stuck in the reporter outbox),
            // and no socket report traffic exists either way
            expect(fake.reports).toEqual([]);
        } finally {
            delete process.env.OMP_HUB_SOCK;
            void env;
        }
    });

    it("hub inactive → socket frames (peer path); guard-2 kicks in only when hubActive", async () => {
        // In-process, sessionId-mismatch is impossible BY DESIGN: facts and
        // state.selfSessionId derive from the SAME ctx capture. The other
        // guard-2 conjunct (hubActive) is the reachable discriminator here:
        // before /hub-start the session reports like any peer over the
        // socket; after it, the same session self-feeds. (The bare
        // sessionId-mismatch decision is unit-covered in hub_reporter.test.ts.)
        const { env, fake, factory } = await makeSelfWired();
        try {
            const { pi, commands: cmdMap, dispatch } = makePi();
            factory(pi as never);
            // session_start BEFORE /hub-start: reporter connects as a peer
            dispatch("session_start", {} as never, makeSelfCtx("s-self-1"));
            await waitFor(async () => fake.reports.length > 0);
            const attach = fake.reports.find((r) => r.frame === "session_start" && (r.payload as { attached?: boolean }).attached === true);
            expect(attach).toBeDefined();
            expect((attach!.payload as { sessionId: string }).sessionId).toBe("s-self-1");

            // /hub-start through the command surface: the REAL wiring, not a
            // hand-built state — compose() defaults to createHubLocal with
            // selfSessionId: () => state.selfSessionId (the tk-hai seam)
            const startCmd = cmdMap.get("hub-start")!;
            await startCmd("", { ui: { notify: () => {}, setWidget: () => {} } });

            // now the SAME session self-feeds: re-announce (guard-4 upsert,
            // registers the row in-process) then an input — socket silent
            dispatch("session_start", {} as never, makeSelfCtx("s-self-1"));
            dispatch("input", { type: "input", text: "self typed after start", source: "interactive" } as never, makeSelfCtx("s-self-1"));
            await waitFor(async () => {
                const snap = await listStatus(env.sock);
                return Object.keys(snap.sessions).includes("s-self-1");
            });
            const afterSelf = fake.reports.length;
            dispatch("input", { type: "input", text: "self typed again", source: "interactive" } as never, makeSelfCtx("s-self-1"));
            await Bun.sleep(50);
            expect(fake.reports.length).toBe(afterSelf);
        } finally {
            delete process.env.OMP_HUB_SOCK;
            void env;
        }
    });
});

// =====================================================================
// helpers
// =====================================================================

/** Poll until cond() holds or timeout — async pipeline, no fixed sleeps. */
const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await cond()) return;
        await Bun.sleep(5);
    }
    throw new Error("waitFor: condition not met within timeout");
};

/** Query the hub roster over the REAL hub.sock cmd path (op:"list"). */
const listStatus = async (sockPath: string): Promise<{ sessions: Record<string, unknown> }> => {
    const { connectHubClient } = await import("@yurifrl/hub/adapters/unix_socket");
    const res = await connectHubClient({ socketPath: sockPath, client: "plugin-test" });
    if (!res.ok) throw res.error;
    try {
        const reply = await res.value.cmd("list");
        if (!reply.ok) throw reply.error;
        return reply.value as { sessions: Record<string, unknown> };
    } finally {
        res.value.close();
    }
};

/** A fake HubClient for order tests: records reports, never closes. */
const makeFakeHubClient = () => {
    const reports: Array<{ frame: string; payload: Record<string, unknown> }> = [];
    const client = {
        report: (frame: string, payload: Record<string, unknown>) => {
            reports.push({ frame, payload });
            return { ok: true, value: undefined } as never;
        },
        cmd: async () => ({ ok: true, value: {} }) as never,
        onEvent: () => {},
        onClose: () => {},
        close: () => {},
    };
    return { client: client as unknown as import("@yurifrl/hub/adapters/unix_socket").HubClient, reports };
};

/** A connected HubClient for frames-into-the-hub assertions. */
const connectClient = async (sockPath: string) => {
    const { connectHubClient } = await import("@yurifrl/hub/adapters/unix_socket");
    const res = await connectHubClient({ socketPath: sockPath, client: "plugin" });
    if (!res.ok) throw res.error;
    return res.value;
};

/** Silence unused-import lint for types used only in docs positions. */
export type Unused = [StatusFile, HubSocketServer, ReturnType<typeof readFile>];
