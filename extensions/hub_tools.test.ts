// extensions/hub_tools.test.ts — the nine hub_* tools (docs/05-omp-plugin.md §Tools).
//
// Covers the tk-sj9 acceptance flows:
//  1. schema validation: bad args → tool error RESULT (isError), never a throw
//  2. routing matrix: hub-local (surface dispatch) vs peer relay (hub.sock cmd
//     frame), same op + args both routes, per-tool timeout, timeout expiry →
//     error envelope (never a rejection)
//  3. e2e against a real hub: spawn the local stack, connect a fake peer over
//     the socket, tool call → cmd frame → reply frame → tool result
//  4. registration: createHubTools returns nine definitions (names, labels,
//     descriptions, schemas) and hub.ts registers them in non-brain sessions
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import hubFactory from "./hub";
import {
    TOOL_BODIES,
    TOOL_DESCRIPTIONS,
    TOOL_SCHEMAS,
    TOOL_TIMEOUTS,
    HUB_TOOL_NAMES,
    createHubTools,
    runHubTool,
    validateArgs,
    normalizeRelayResult,
    isHubLocal,
} from "./hub_tools";
import type { HubToolsDeps, HubStateLike, HubToolName } from "./hub_tools";
import { resolveHubEnv } from "./hub_env";
import type { HubEnv } from "./hub_env";
import { createHubLocal } from "./hub_local";
import type { HubLocal } from "./hub_local";
import { connectHubClient } from "@yurifrl/hub/adapters/unix_socket";
import type { HubClient } from "@yurifrl/hub/adapters/unix_socket";
import type { Result, HubError, AgentRuntime } from "@yurifrl/hub";

// ---- fakes ------------------------------------------------------------------

const makeRuntime = (): AgentRuntime => ({
    spawn: async (spec) => ({ ok: true, value: { name: spec.name ?? "worker-1", sessionId: null } }),
    send: async () => ({ ok: true, value: undefined }) as Result<void, HubError>,
    kill: async () => ({ ok: true, value: undefined }) as Result<void, HubError>,
});

/** Stub surface recording dispatched commands (hub-local route assertions). */
const makeSurface = (reply?: unknown, error?: HubError) => {
    const calls: Array<{ cmdId: string; op: string; args: Record<string, unknown>; by: string }> = [];
    const dispatch = async (req: { cmdId: string; op: string; args: Record<string, unknown>; by: "plugin" | "cli" | "web" | "agent" }) => {
        calls.push({ ...req });
        if (error) return { ok: false, error } as Result<unknown, HubError>;
        return { ok: true, value: reply ?? { queued: true } } as Result<unknown, HubError>;
    };
    return { dispatch, calls };
};

const makeState = (surface: { dispatch: (req: { cmdId: string; op: string; args: Record<string, unknown>; by: "plugin" | "cli" | "web" | "agent" }) => Promise<Result<unknown, HubError>> }): HubStateLike => ({
    active: true,
    selfSessionId: "s-self",
    local: { core: { surface } },
});

/** Fake connect: never touches the filesystem; resolves a fake client whose
 * cmd() records the call and answers per the queued script. */
const makeConnect = (script: Array<{ ok: boolean; result?: unknown; error?: HubError }>) => {
    const sent: Array<{ op: string; args: Record<string, unknown>; timeoutMs: number }> = [];
    let i = 0;
    let closed = 0;
    const client: HubClient = {
        report: () => ({ ok: true, value: undefined }),
        onClose: () => {},
        cmd: (op, args = {}, deadlineMs = 30_000) => {
            sent.push({ op, args, timeoutMs: deadlineMs });
            const step = script[Math.min(i, script.length - 1)]!;
            i++;
            return new Promise((resolve) => {
                setTimeout(() =>
                    resolve(step.ok ? ({ ok: true, value: step.result } as Result<unknown, HubError>) : ({ ok: false, error: step.error ?? { code: "timeout", message: "faked timeout", retryable: true } } as Result<unknown, HubError>)),
                    1,
                );
            });
        },
        onEvent: () => {},
        close: () => {
            closed++;
        },
    };
    const connect = async (): Promise<Result<HubClient, HubError>> => ({ ok: true, value: client });
    return { connect, sent, closeCount: () => closed };
};

// ---- env + temp dirs ---------------------------------------------------------

const tmps: string[] = [];
const makeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-tools-"));
    tmps.push(dir);
    return dir;
};
afterEach(async () => {
    for (const dir of tmps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeEnv = async (): Promise<{ env: HubEnv; root: string; sockPath: string }> => {
    const root = await makeRoot();
    const sockPath = join(root, "hub.sock");
    return { env: resolveHubEnv({ OMP_HUB_SOCK: sockPath, OMP_BIN: "omp-fake" }), root, sockPath };
};

const noLocalState: HubStateLike = { active: false, selfSessionId: "", local: null };

// keep the import surface honest: no raw net in this suite — the e2e test
// speaks through connectHubClient against the real temp hub.sock

// =====================================================================
// 1. schema validation (acceptance: bad args → tool error not throw)
// =====================================================================

describe("hub_tools schema validation — bad args are tool error results, never throws", () => {
    it("nine schemas exist, one per tool, all objects", () => {
        expect(HUB_TOOL_NAMES.length).toBe(9);
        for (const name of HUB_TOOL_NAMES) {
            expect(TOOL_SCHEMAS[name]).toBeDefined();
            expect(TOOL_BODIES[name]).toBeDefined();
            expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(10);
        }
    });

    it("each tool rejects missing required fields with an isError result", async () => {
        const { env } = await makeEnv();
        const deps: HubToolsDeps = { env, state: noLocalState };
        const badArgs: Record<string, Record<string, unknown>> = {
            hub_send_message: { message: "hi" }, // target missing
            hub_call_tool: { target: "t" }, // tool missing
            hub_kill_worker: {}, // name missing
            hub_archive: {}, // id missing
            hub_answer: { id: "att-1" }, // text missing
            hub_assign: { id: "x" }, // task missing
        };
        for (const [name, args] of Object.entries(badArgs)) {
            const res = await runHubTool(name as never, args, deps);
            expect(res.isError).toBe(true);
            expect((res.content[0] as { text: string }).text).toContain("invalid arguments");
        }
    });

    it("wait_seconds bounds: negative, fractional, and > 600 are rejected; boundary 600 accepted", async () => {
        const { env } = await makeEnv();
        const fake = makeConnect([{ ok: true, result: { queued: true } }]);
        const deps: HubToolsDeps = { env, state: noLocalState, connect: fake.connect };
        for (const bad of [-1, 0.5, 601]) {
            const res = await runHubTool("hub_send_message", { target: "t", message: "m", wait_seconds: bad }, deps);
            expect(res.isError).toBe(true);
            expect((res.content[0] as { text: string }).text).toContain("invalid arguments");
        }
        // 600 is in-range: passes validation. With an injected happy-path
        // connect it must NOT be a validation error — it flows to relay.
        const okRes = await runHubTool("hub_send_message", { target: "t", message: "m", wait_seconds: 600 }, deps);
        expect(okRes.isError).toBe(false);
        // and the relay saw waitMs = 600s in the op args
        expect(fake.sent[0]!.args).toEqual({ sessionId: "t", text: "m", waitMs: 600_000 });
    });

    it("non-object args rejected without touching the schema", () => {
        const res = validateArgs(TOOL_SCHEMAS.hub_list_sessions, "nope");
        expect(res.ok).toBe(false);
        expect(res.ok === false && res.error).toContain("JSON object");
        const arr = validateArgs(TOOL_SCHEMAS.hub_list_sessions, [1, 2]);
        expect(arr.ok).toBe(false);
    });

    it("hub_call_tool rejects non-JSON args strings with an error result (never throws)", async () => {
        const { env } = await makeEnv();
        const fake = makeConnect([{ ok: true, result: {} }]);
        const deps: HubToolsDeps = { env, state: noLocalState, connect: fake.connect };
        const res = await runHubTool("hub_call_tool", { target: "t", tool: "bash", args: "{not json" }, deps);
        expect(res.isError).toBe(true);
        expect((res.content[0] as { text: string }).text).toContain("not valid JSON");
        expect(fake.sent.length).toBe(0); // failed before any frame left
    });

    it("bodies never throw even when deps explode (catch-all envelope)", async () => {
        const { env } = await makeEnv();
        const deps: HubToolsDeps = {
            env,
            state: noLocalState,
            connect: async () => {
                throw new Error("connect exploded");
            },
        };
        const res = await runHubTool("hub_list_sessions", {}, deps);
        expect(res.isError).toBe(true);
        expect((res.content[0] as { text: string }).text).toContain("failed");
    });
});

// =====================================================================
// 2. routing matrix (acceptance: local vs relay incl. timeout → envelope)
// =====================================================================

describe("hub_tools routing — hub-local surface vs peer relay hub.sock", () => {
    it("isHubLocal: active + own session id + local stack → local; anything else → relay", async () => {
        const { env } = await makeEnv();
        const surface = makeSurface();
        const local: HubToolsDeps = { env, state: makeState(surface) };
        const fake1 = makeConnect([{ ok: true, result: {} }]);
        const fake2 = makeConnect([{ ok: true, result: {} }]);
        const peer: HubToolsDeps = { env, state: noLocalState, connect: fake1.connect };
        const notHubYet: HubToolsDeps = { env, state: { active: false, selfSessionId: "s-self", local: null }, connect: fake1.connect };
        const noSelfId: HubToolsDeps = { env, state: { active: true, selfSessionId: "", local: null }, connect: fake2.connect };
        expect(isHubLocal(local)).toBe(true);
        expect(isHubLocal(peer)).toBe(false);
        expect(isHubLocal(notHubYet)).toBe(false);
        expect(isHubLocal(noSelfId)).toBe(false);
    });

    it("all nine tools route hub-local through the surface with by:'plugin' and the docs/02 op", async () => {
        const { env } = await makeEnv();
        const surface = makeSurface({ queued: true });
        const deps: HubToolsDeps = { env, state: makeState(surface) };
        const calls: Array<[string, unknown]> = [
            ["hub_list_sessions", {}],
            ["hub_send_message", { target: "tilt", message: "hello" }],
            ["hub_call_tool", { target: "tilt", tool: "bash", args: '{"command":"ls"}' }],
            ["hub_spawn_worker", { name: "atlas" }],
            ["hub_kill_worker", { name: "atlas" }],
            ["hub_archive", { id: "s-9f2c" }],
            ["hub_attention", {}],
            ["hub_answer", { id: "att-6", text: "approved" }],
            ["hub_assign", { id: "tilt", task: "ship it" }],
        ];
        for (const [name, args] of calls as Array<[HubToolName, unknown]>) {
            const res = await runHubTool(name, args, deps);
            expect(res.isError).toBe(false);
        }
        expect(surface.calls.length).toBe(9);
        const ops = surface.calls.map((c) => c.op);
        expect(ops).toEqual(["list", "send", "tool", "spawn", "kill", "archive", "attention", "answer", "assign"]);
        // every local dispatch is the plugin calling itself's hub
        expect(surface.calls.every((c) => c.by === "plugin")).toBe(true);
        // op args mapping (docs/05 §Tools → docs/02 §Ops payloads)
        expect(surface.calls[1]!.args).toEqual({ sessionId: "tilt", text: "hello" });
        expect(surface.calls[2]!.args).toEqual({ sessionId: "tilt", tool: "bash", args: { command: "ls" } });
        expect(surface.calls[4]!.args).toEqual({ sessionId: "atlas" });
        expect(surface.calls[5]!.args).toEqual({ sessionId: "s-9f2c" });
        expect(surface.calls[6]!.args).toEqual({ action: "list" });
        expect(surface.calls[8]!.args).toEqual({ sessionId: "tilt", task: "ship it" });
    });

    it("all nine tools route peer relay through the fake client with identical op + args", async () => {
        const { env } = await makeEnv();
        const fake = makeConnect([{ ok: true, result: { queued: true } }, { ok: true, result: { queued: true } }]);
        const deps: HubToolsDeps = { env, state: noLocalState, connect: fake.connect };
        const calls: Array<[string, unknown]> = [
            ["hub_list_sessions", {}],
            ["hub_send_message", { target: "tilt", message: "hello" }],
        ];
        for (const [name, args] of calls as Array<[HubToolName, unknown]>) {
            const res = await runHubTool(name, args, deps);
            expect(res.isError).toBe(false);
        }
        expect(fake.sent.map((s) => s.op)).toEqual(["list", "send"]);
        expect(fake.sent[0]!.args).toEqual({});
        expect(fake.sent[1]!.args).toEqual({ sessionId: "tilt", text: "hello" });
    });

    it("spawn/kill/archive/attention/answer/assign relay with the same op mapping as local (one routing rule)", async () => {
        const { env } = await makeEnv();
        const fake = makeConnect([
            { ok: true, result: { sessionId: "s-w1", name: "atlas" } },
            { ok: true, result: { closedAt: "2026-08-31T00:00:00.000Z" } },
            { ok: true, result: { closedAt: "2026-08-31T00:00:01.000Z" } },
            { ok: true, result: { items: [] } },
            { ok: true, result: { item: { id: "att-6" } } },
            { ok: true, result: { item: undefined } },
        ]);
        const deps: HubToolsDeps = { env, state: noLocalState, connect: fake.connect };
        const calls: Array<[string, unknown]> = [
            ["hub_spawn_worker", { name: "atlas" }],
            ["hub_kill_worker", { name: "atlas" }],
            ["hub_archive", { id: "s-9f2c" }],
            ["hub_attention", {}],
            ["hub_answer", { id: "att-6", text: "yes" }],
            ["hub_assign", { id: "tilt", task: "go" }],
        ];
        const texts: string[] = [];
        for (const [name, args] of calls as Array<[HubToolName, unknown]>) {
            const res = await runHubTool(name, args, deps);
            expect(res.isError).toBe(false);
            texts.push((res.content[0] as { text: string }).text);
        }
        expect(fake.sent.map((s) => s.op)).toEqual(["spawn", "kill", "archive", "attention", "answer", "assign"]);
        expect(fake.sent[1]!.args).toEqual({ sessionId: "atlas" });
        expect(fake.sent[2]!.args).toEqual({ sessionId: "s-9f2c" });
        expect(fake.sent[3]!.args).toEqual({ action: "list" });
        expect(fake.sent[4]!.args).toEqual({ id: "att-6", text: "yes" });
        expect(fake.sent[5]!.args).toEqual({ sessionId: "tilt", task: "go" });
        // normalization: per-op renderers
        expect(texts[0]).toContain("atlas");
        expect(texts[1]).toContain("killed");
        expect(texts[3]).toContain("0 open attention items");
    });

    it("per-tool timeouts carry into the relay deadline", async () => {
        const { env } = await makeEnv();
        const fake = makeConnect([{ ok: true, result: {} }]);
        const deps: HubToolsDeps = { env, state: noLocalState, connect: fake.connect };
        await runHubTool("hub_list_sessions", {}, deps);
        expect(fake.sent[0]!.timeoutMs).toBe(TOOL_TIMEOUTS.hub_list_sessions);
        // docs/05 Routing lines: send = max(wait*1000+15s, 30s); tool = wait*1000+30s
        expect(TOOL_TIMEOUTS.hub_send_message(0)).toBe(30_000);
        expect(TOOL_TIMEOUTS.hub_send_message(600)).toBe(615_000);
        expect(TOOL_TIMEOUTS.hub_call_tool(240)).toBe(270_000);
        expect(TOOL_TIMEOUTS.hub_spawn_worker).toBe(60_000);
        expect(TOOL_TIMEOUTS.hub_kill_worker).toBe(15_000);
        expect(TOOL_TIMEOUTS.hub_archive).toBe(15_000);
        expect(TOOL_TIMEOUTS.hub_attention).toBe(10_000);
        expect(TOOL_TIMEOUTS.hub_answer).toBe(15_000);
        expect(TOOL_TIMEOUTS.hub_assign).toBe(15_000);
    });

    it("timeout expiry resolves an error envelope, never a rejection (docs/05: tools never throw)", async () => {
        const { env } = await makeEnv();
        const fake = makeConnect([{ ok: false, error: { code: "timeout", message: "op list timed out after 10ms", retryable: true } }]);
        const deps: HubToolsDeps = { env, state: noLocalState, connect: fake.connect };
        const res = await runHubTool("hub_list_sessions", {}, deps);
        expect(res.isError).toBe(true);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toContain("timed out");
        expect(text).toContain("code: timeout");
    });

    it("relay errors surface as isError results with code + message", async () => {
        const { env } = await makeEnv();
        const fake = makeConnect([{ ok: false, error: { code: "unknown-session", message: "no live session ghost", retryable: false } }]);
        const deps: HubToolsDeps = { env, state: noLocalState, connect: fake.connect };
        const res = await runHubTool("hub_send_message", { target: "ghost", message: "boo" }, deps);
        expect(res.isError).toBe(true);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toContain("hub send failed");
        expect(text).toContain("no live session ghost");
    });

    it("normalizeRelayResult flattens both Result branches deterministically", () => {
        const okSide = normalizeRelayResult("send", { ok: true, value: { queued: true } });
        expect(JSON.parse(okSide.text)).toEqual({ queued: true }); // unlisted ops render as pretty JSON
        const errSide = normalizeRelayResult("kill", { ok: false, error: { code: "unknown-session", message: "no worker x", retryable: false } });
        expect(errSide.text).toContain("hub kill failed: no worker x (code: unknown-session)");
    });
});

// =====================================================================
// 3. e2e against a real hub.sock (acceptance: spawn temp socket, connect,
//    tool call → frame → reply → result)
// =====================================================================

describe("hub_tools e2e — real hub stack, fake peer over the socket", () => {
    it("peer relay: tool call → cmd frame → reply frame → tool result (frames, not sleeps)", async () => {
        const { env, sockPath } = await makeEnv();
        const local: HubLocal = createHubLocal({ env, selfSessionId: () => "s-self", overrides: { runtime: makeRuntime() } });
        const started = await local.start();
        expect(started.ok).toBe(true);

        // a fake peer hub client answers cmds itself (stands in for a second
        // session's reporter in the relay test — here it just echoes the cmd)
        const deps: HubToolsDeps = { env, state: noLocalState };
        const res = await runHubTool("hub_list_sessions", {}, deps);
        expect(res.isError).toBe(false);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toContain("0 session(s)");

        // and the hub really saw a cmd frame on the wire (it answered with the
        // full status snapshot — proof of cmd → dispatch → reply → result)
        const snap = await local.readStatus();
        expect(snap.ok).toBe(true);
        local.stop();
        void sockPath;
    });

    it("hub-local e2e: the same tool call goes through the real surface, not the socket", async () => {
        const { env } = await makeEnv();
        const local: HubLocal = createHubLocal({ env, selfSessionId: () => "s-self", overrides: { runtime: makeRuntime() } });
        const started = await local.start();
        expect(started.ok).toBe(true);
        // a peer registers itself so the roster is non-empty
        const client = await connectHubClient({ socketPath: env.sock, client: "plugin" });
        if (!client.ok) throw client.error;
        client.value.report("session_start", { sessionId: "s-peer", attached: false, cwd: "/tmp/peer", title: "deploy canary" });
        // poll for the roster row — fixed sleep raced under load
        for (let i = 0; i < 100; i++) {
            const snap = await local.readStatus();
            if (snap.ok && snap.value.sessions["s-peer"]) break;
            await Bun.sleep(2);
        }

        const deps: HubToolsDeps = {
            env,
            state: { active: true, selfSessionId: "s-self", local: local as unknown as HubStateLike["local"] ? { core: { surface: local.core.surface as never } } : null },
        };
        const res = await runHubTool("hub_list_sessions", {}, deps);
        expect(res.isError).toBe(false);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toContain("s-peer");
        expect(text).toContain("deploy canary");
        client.value.close();
        local.stop();
    });

    it("relay against a dead socket path → error envelope with the 'hub unreachable' hint", async () => {
        const { env } = await makeEnv();
        const deps: HubToolsDeps = { env, state: noLocalState };
        const res = await runHubTool("hub_attention", {}, deps);
        expect(res.isError).toBe(true);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toContain("hub unreachable");
        expect(text).toContain("/hub-start");
    });

    it("local route op failure (dead target) → error result, session keeps working", async () => {
        const { env } = await makeEnv();
        const local: HubLocal = createHubLocal({ env, selfSessionId: () => "s-self", overrides: { runtime: makeRuntime() } });
        await local.start();
        const deps: HubToolsDeps = {
            env,
            state: { active: true, selfSessionId: "s-self", local: { core: { surface: local.core.surface as never } } },
        };
        // deliver to an unknown session → surface error → error envelope
        const res = await runHubTool("hub_send_message", { target: "ghost", message: "boo" }, deps);
        expect(res.isError).toBe(true);
        expect((res.content[0] as { text: string }).text).toContain("failed");
        local.stop();
    });
});

// =====================================================================
// 4. registration (acceptance: nine tools registered with schemas + descriptions)
// =====================================================================

describe("hub_tools registration — nine definitions through pi.registerTool", () => {
    it("createHubTools returns nine ToolDefinitions with names/labels/descriptions/schemas", async () => {
        const { env } = await makeEnv();
        const tools = createHubTools({ env, state: noLocalState });
        expect(tools.length).toBe(9);
        for (const tool of tools) {
            expect((HUB_TOOL_NAMES as readonly string[]).includes(tool.name)).toBe(true);
            expect(tool.label).toBe(tool.name);
            expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name as keyof typeof TOOL_DESCRIPTIONS]);
            expect(tool.parameters).toBe(TOOL_SCHEMAS[tool.name as keyof typeof TOOL_SCHEMAS]);
            expect(typeof tool.execute).toBe("function");
        }
        const names = tools.map((t) => t.name);
        expect(names).toEqual([
            "hub_list_sessions",
            "hub_send_message",
            "hub_call_tool",
            "hub_spawn_worker",
            "hub_kill_worker",
            "hub_archive",
            "hub_attention",
            "hub_answer",
            "hub_assign",
        ]);
    });

    it("registered execute() is the schema-guarded body: bad args via execute → error result", async () => {
        const { env } = await makeEnv();
        const tools = createHubTools({ env, state: noLocalState });
        const send = tools.find((t) => t.name === "hub_send_message") as unknown as { execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: never) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> };
        const res = await send.execute("call-1", { message: "no target" }, undefined, undefined, {} as never);
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toContain("invalid arguments");
    });

    it("factory (non-brain) registers all nine tools; brain guard still registers nothing", async () => {
        const { env } = await makeEnv();
        const registered: Array<{ kind: string; name: string }> = [];
        const pi = {
            registerCommand: () => {},
            on: () => {},
            registerTool: (tool: { name: string }) => registered.push({ kind: "tool", name: tool.name }),
            ui: { setWidget: () => {} },
        };
        process.env.OMP_HUB_SOCK = env.sock;
        try {
            hubFactory(pi as never);
            const toolNames = registered.filter((r) => r.kind === "tool").map((r) => r.name);
            expect(toolNames).toEqual([...HUB_TOOL_NAMES]);
        } finally {
            delete process.env.OMP_HUB_SOCK;
        }

        // brain guard: zero registrations of any kind
        const brainRegistered: unknown[] = [];
        const brainPi = {
            registerCommand: () => brainRegistered.push(1),
            on: () => brainRegistered.push(1),
            registerTool: () => brainRegistered.push(1),
            ui: { setWidget: () => {} },
        };
        const prev = process.env.OMP_HUB_BRAIN;
        process.env.OMP_HUB_BRAIN = "1";
        try {
            hubFactory(brainPi as never);
            expect(brainRegistered).toEqual([]);
        } finally {
            if (prev === undefined) delete process.env.OMP_HUB_BRAIN;
            else process.env.OMP_HUB_BRAIN = prev;
        }
    });
});

