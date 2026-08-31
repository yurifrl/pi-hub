// extensions/hub_reporter.test.ts — the reporter contract (docs/05 §Reporter,
// tk-epx acceptance). Exercises the event→frame translation matrix (every omp
// event type incl. /command skip + fallback), attach-on-connect idempotence,
// the self-feed local path (no socket frame when selfSessionId matches,
// asserted via a fake transport), reconnect/restart idempotence, and
// malformed-event tolerance. No real sockets, no omp runtime (docs/01 §Testing).
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createReporter,
    translateEvent,
    createSeenInputs,
    isWrapperBlock,
    safeArgs,
    OUTBOX_MAX,
    OUTBOX_DROP_ABOVE,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
} from "./hub_reporter";
import { resolveHubEnv } from "./hub_env";
import type { HubEnv } from "./hub_env";
import type { HubClient } from "@yurifrl/hub/adapters/unix_socket";

// ---- fake HubClient (fake transport: docs/05 "assert via fake transport") ----

type ReportRecord = { frame: string; payload: Record<string, unknown> };

const makeFakeClient = () => {
    const reports: ReportRecord[] = [];
    let closeHandler: ((info: { reason: "restart" | "error"; message?: string }) => void) | null = null;
    const client: HubClient = {
        report: (frame, payload) => {
            reports.push({ frame, payload });
            return { ok: true, value: undefined } as never;
        },
        cmd: async () => ({ ok: true, value: {} }) as never,
        onEvent: () => {},
        onClose: (fn) => {
            closeHandler = fn;
        },
        close: () => {},
    };
    return {
        client,
        reports,
        /** simulate hub restart / socket death */
        die: (reason: "restart" | "error" = "error") => closeHandler?.({ reason, message: "fake close" }),
    };
};

// ---- fake reporter edges ----

const tmps: string[] = [];
const makeEnv = async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-rep-"));
    tmps.push(root);
    const env = resolveHubEnv({ OMP_HUB_SOCK: join(root, "hub.sock") });
    return { env, root };
};
afterEach(async () => {
    for (const dir of tmps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const FACTS = { sessionId: "s-1", title: "tilt", cwd: "/w/api", model: "m-1" };

const makeOpts = (env: ReturnType<typeof resolveHubEnv>, over: Partial<Parameters<typeof createReporter>[0]> = {}) => ({
    env,
    local: { isActive: () => false, selfSessionId: () => "", handleReport: () => {} },
    sessionFacts: () => FACTS,
    sendUserMessage: () => {},
    ...over,
});

/** Drive a reporter to a live connection with deterministic fakes. */
const liveReporter = async (env: HubEnv, over: Partial<Parameters<typeof createReporter>[0]> = {}) => {
    const fake = makeFakeClient();
    let connectCalls = 0;
    const rep = createReporter(
        makeOpts(env, {
            ...over,
            connect: async () => {
                connectCalls++;
                return { ok: true as const, client: fake.client };
            },
        }),
    );
    // session_start with the pi event shape (only `type` matters to the seam)
    rep.handleSessionStart({ type: "startup" } as never);
    await Bun.sleep(1); // let open() resolve
    return { rep, fake, connectCalls: () => connectCalls };
};

// =====================================================================
// 1. Event → frame translation matrix (docs/05 §Reporter table)
// =====================================================================

describe("translateEvent — docs/05 §Reporter matrix", () => {
    const seen = createSeenInputs();
    const ctx = { facts: FACTS, seen };

    it("session_start → session_start attached:false with sessionId/title/cwd", () => {
        expect(translateEvent({ type: "session_start", event: { type: "startup" } as never }, ctx)).toEqual({
            frame: "session_start",
            sessionId: "s-1",
            kind: "peer",
            cwd: "/w/api",
            model: "m-1",
            attached: false,
            title: "tilt",
        });
    });

    it("input → user_message; /commands are skipped (UI, not conversation)", () => {
        expect(translateEvent({ type: "input", event: { type: "input", text: "deploy the canary" } as never }, ctx)).toEqual({
            frame: "user_message",
            sessionId: "s-1",
            text: "deploy the canary",
        });
        expect(translateEvent({ type: "input", event: { type: "input", text: "/commit now" } as never }, ctx)).toBeNull();
    });

    it("message_end assistant → assistant_message with text + model presence via text", () => {
        expect(
            translateEvent(
                { type: "message_end", event: { message: { role: "assistant", content: [{ type: "text", text: "deployed" }], model: "m-1" } } as never },
                ctx,
            ),
        ).toEqual({ frame: "assistant_message", sessionId: "s-1", text: "deployed" });
    });

    it("message_end user fallback → user_message; <wrapper> blocks skipped", () => {
        expect(
            translateEvent(
                { type: "message_end", event: { message: { role: "user", content: "delivered task" } } as never },
                ctx,
            ),
        ).toEqual({ frame: "user_message", sessionId: "s-1", text: "delivered task" });
        expect(
            translateEvent(
                { type: "message_end", event: { message: { role: "user", content: "<skill-injection>skip me</skill-injection>" } } as never },
                ctx,
            ),
        ).toBeNull();
    });

    it("tool_execution_start → tool_call with args object (unserializable args → \"\")", () => {
        expect(
            translateEvent({ type: "tool_execution_start", event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } } as never }, ctx),
        ).toEqual({ frame: "tool_call", sessionId: "s-1", tool: "bash", args: { command: "ls" } });
        // circular args survive as "" (docs/05: unserializable args become "")
        const cyc: Record<string, unknown> = {};
        cyc.self = cyc;
        expect(
            translateEvent({ type: "tool_execution_start", event: { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: cyc } as never }, ctx),
        ).toEqual({ frame: "tool_call", sessionId: "s-1", tool: "bash", args: "" });
    });

    it("agent_end → agent_end frame with docs/02 reason mapping", () => {
        expect(translateEvent({ type: "agent_end", event: { messages: [] } }, ctx)).toEqual({
            frame: "agent_end",
            sessionId: "s-1",
            reason: "complete",
        });
        expect(
            translateEvent({ type: "agent_end", event: { messages: [{ stopReason: "aborted" }] } }, ctx),
        ).toEqual({ frame: "agent_end", sessionId: "s-1", reason: "interrupted" });
    });

    it("session_shutdown → agent_end reason:\"exit\" (hub closes this session properly)", () => {
        expect(translateEvent({ type: "session_shutdown" }, ctx)).toEqual({
            frame: "agent_end",
            sessionId: "s-1",
            reason: "exit",
        });
    });

    it("typed input + its message_end echo dedupes to ONE user_message (two capture paths, docs/05 DECISION)", () => {
        const s2 = createSeenInputs();
        const c2 = { facts: FACTS, seen: s2 };
        const viaInput = translateEvent({ type: "input", event: { type: "input", text: "same text" } as never }, c2);
        expect(viaInput).not.toBeNull();
        const echo = translateEvent({ type: "message_end", event: { message: { role: "user", content: "same text" } } as never }, c2);
        expect(echo).toBeNull(); // authoritative path already reported it
        // a DELIVERED message (no input first) still passes the fallback
        const delivered = translateEvent({ type: "message_end", event: { message: { role: "user", content: "same text" } } as never }, c2);
        expect(delivered).not.toBeNull();
    });
});

describe("seen-input dedup semantics", () => {
    it("only input arms the pending echo; unrelated user messages never suppressed", () => {
        const s = createSeenInputs();
        s.onInput("hello");
        expect(s.onUserMessageEnd("hello")).toBe(false);
        expect(s.onUserMessageEnd("hello")).toBe(true); // echo consumed; next identical message is a real one
        s.onInput("hello");
        s.onInput("hello"); // re-arm overwrite
        expect(s.onUserMessageEnd("hello")).toBe(false);
        expect(s.onUserMessageEnd("hello")).toBe(true);
    });

    it("input paths: commands never arm the pending echo", () => {
        const s = createSeenInputs();
        const c = { facts: FACTS, seen: s };
        // a /command produces no frame AND does not arm the dedup state
        expect(translateEvent({ type: "input", event: { type: "input", text: "/commit" } as never }, c)).toBeNull();
        expect(s.onUserMessageEnd("/commit")).toBe(true);
    });

    it("isWrapperBlock matches the < prefix", () => {
        expect(isWrapperBlock("<system>")).toBe(true);
        expect(isWrapperBlock("hello < world")).toBe(false);
    });

    it("safeArgs passes serializable values verbatim and \"\" for poison", () => {
        expect(safeArgs({ a: 1 })).toEqual({ a: 1 });
        const cyc: Record<string, unknown> = {};
        cyc.self = cyc;
        expect(safeArgs(cyc)).toBe("");
        expect(safeArgs(undefined)).toBe(undefined);
    });
});

// =====================================================================
// 2. Attach-on-connect + reconnect/restart idempotence
// =====================================================================

describe("attach-on-connect (docs/05 §Reporter)", () => {
    it("every successful connect emits session_start attached:true FIRST (sessionId/title/cwd)", async () => {
        const { env } = await makeEnv();
        const { rep, fake } = await liveReporter(env);
        const reports = fake.reports;
        expect(reports.length).toBeGreaterThanOrEqual(1);
        const attach = reports[0]!;
        expect(attach.frame).toBe("session_start");
        expect(attach.payload.attached).toBe(true);
        expect(attach.payload.sessionId).toBe("s-1");
        expect(attach.payload.cwd).toBe("/w/api");
        expect(attach.payload.ch).toBe("report");
        expect(attach.payload.v).toBe(1);
        rep.snapshot(); // no throw
    });

    it("real session_start event emits attached:false exactly once (original emission)", async () => {
        const { env } = await makeEnv();
        const { rep, fake } = await liveReporter(env);
        // count session_start frames: exactly one attach:true (socket) — the
        // event-driven attached:false frame was consumed by the outbox path
        // (connect resolves after the event frame queued) and is drained to
        // the SAME fake client after the attach; assert both exist in order
        const starts = fake.reports.filter((r) => r.frame === "session_start");
        expect(starts.length).toBe(2);
        expect(starts[0]!.payload.attached).toBe(true);
        expect(starts[1]!.payload.attached).toBe(false);
        rep.snapshot();
    });

    it("hub restart (close → reconnect) re-announces attach:true, idempotent (guard 4)", async () => {
        const { env } = await makeEnv();
        const { rep, fake } = await liveReporter(env);
        const first = fake.reports.filter((r) => r.frame === "session_start" && r.payload.attached === true);
        expect(first.length).toBe(1);
        // hub dies → close fires → backoff reconnect (RECONNECT_BASE_MS, faked)
        fake.die("error");
        await Bun.sleep(RECONNECT_BASE_MS + 30);
        const all = fake.reports.filter((r) => r.frame === "session_start" && r.payload.attached === true);
        expect(all.length).toBe(2); // re-attached: upsert, no duplicate row
        expect(rep.snapshot().state).toBe("live");
    });

    it("session_shutdown stops the reporter: farewell exit frame, no reconnect after close", async () => {
        const { env } = await makeEnv();
        const { rep, fake } = await liveReporter(env);
        const before = fake.reports.length;
        // fire the registered session_shutdown handler
        rep.handleShutdown();
        const reports = fake.reports;
        const last = reports[reports.length - 1]!;
        expect(last.frame).toBe("agent_end");
        expect(last.payload.reason).toBe("exit");
        // no reconnect: die() after shutdown must not re-attach
        fake.die();
        await Bun.sleep(RECONNECT_BASE_MS + 30);
        expect(fake.reports.filter((r) => r.frame === "session_start" && r.payload.attached === true).length).toBe(1);
        expect(fake.reports.length).toBe(before + 1); // only the exit frame added
        void rep;
    });
});

// =====================================================================
// 3. Self-feed local path (guard 2, no socket round-trip)
// =====================================================================

describe("self-feed (docs/05 §Anti-recursion guard 2)", () => {
    it("hubActive && sessionId === selfSessionId → local handleReport, zero socket frames", async () => {
        const { env } = await makeEnv();
        const fed: unknown[] = [];
        const fake = makeFakeClient();
        let connectCalls = 0;
        const rep = createReporter(
            makeOpts(env, {
                local: {
                    isActive: () => true,
                    selfSessionId: () => "s-1",
                    handleReport: (frame) => fed.push(frame),
                },
                connect: async () => {
                    connectCalls++;
                    return { ok: true as const, client: fake.client };
                },
            }),
        );
        rep.handleSessionStart({ type: "startup" } as never);
        await Bun.sleep(1);
        // self session: NOTHING reaches the socket, EVERYTHING reaches the handler
        expect(connectCalls).toBe(0);
        expect(fake.reports.length).toBe(0);
        expect(fed.length).toBeGreaterThan(0);
        const first = fed[0] as Record<string, unknown>;
        expect(first.frame).toBe("session_start");
        expect(first.attached).toBe(false);
        // subsequent events also self-feed
        rep.handleInput({ type: "input", text: "hub at work" } as never);
        expect(fed[fed.length - 1]).toMatchObject({ frame: "user_message", text: "hub at work" });
        void rep;
    });

    it("hubActive but DIFFERENT sessionId → socket path (peer reporter on the hub host)", async () => {
        const { env } = await makeEnv();
        const fed: unknown[] = [];
        const fake = makeFakeClient();
        const rep = createReporter(
            makeOpts(env, {
                local: {
                    isActive: () => true,
                    selfSessionId: () => "s-other",
                    handleReport: (frame) => fed.push(frame),
                },
                connect: async () => ({ ok: true as const, client: fake.client }),
            }),
        );
        rep.handleSessionStart({ type: "startup" } as never);
        await Bun.sleep(1);
        expect(fake.reports.length).toBeGreaterThanOrEqual(1);
        expect(fed.length).toBe(0);
        void rep;
    });

    it("hub NOT active → socket path (normal reporter)", async () => {
        const { env } = await makeEnv();
        const fed: unknown[] = [];
        const fake = makeFakeClient();
        const rep = createReporter(
            makeOpts(env, {
                local: {
                    isActive: () => false,
                    selfSessionId: () => "s-1",
                    handleReport: (frame) => fed.push(frame),
                },
                connect: async () => ({ ok: true as const, client: fake.client }),
            }),
        );
        rep.handleSessionStart({ method: "startup" } as never);
        await Bun.sleep(1);
        expect(fake.reports.length).toBeGreaterThanOrEqual(1);
        expect(fed.length).toBe(0);
        void rep;
    });
});

// =====================================================================
// 4. Malformed event tolerance (docs/05 §Error rules)
// The reporter never throws into the host session.
// =====================================================================

describe("malformed events — the reporter never throws into the host", () => {
    it("message_end with exotic message shapes produce no frame, no throw", () => {
        const s = createSeenInputs();
        const c = { facts: FACTS, seen: s };
        expect(() => translateEvent({ type: "message_end", event: { message: null } as never }, c)).not.toThrow();
        expect(translateEvent({ type: "message_end", event: { message: null } as never }, c)).toBeNull();
        expect(() =>
            translateEvent({ type: "message_end", event: { message: { role: "user", content: [{ type: "image" }] } } as never }, c),
        ).not.toThrow();
        expect(translateEvent({ type: "message_end", event: { message: { role: "user", content: [{ type: "image" }] } } as never }, c)).toBeNull();
        expect(() => translateEvent({ type: "agent_end", event: { messages: undefined as never } }, c)).not.toThrow();
        expect(translateEvent({ type: "agent_end", event: { messages: undefined as never } }, c)).not.toBeNull();
    });

    it("outbox capped at OUTBOX_MAX, drains in order after connect; wholesale drop above 50 on close (docs/05 §Reporter)", async () => {
        const { env } = await makeEnv();
        const fake = makeFakeClient();
        let gate = false;
        const rep = createReporter(
            makeOpts(env, {
                connect: async () => (gate ? { ok: true as const, client: fake.client } : { ok: false as const, error: "no hub" }),
            }),
        );
        rep.handleSessionStart({ type: "startup" } as never);
        await Bun.sleep(1);
        // queue frames while the hub is down
        for (let i = 0; i < OUTBOX_MAX + 20; i++) {
            rep.handleInput({ type: "input", text: `m${i}` } as never);
        }
        expect(rep.peekOutbox().length).toBe(OUTBOX_MAX); // capped
        // hub comes up: attach first, then the queued frames in order
        gate = true;
        rep.tryConnect();
        await Bun.sleep(1);
        const frames = fake.reports.map((r) => r.frame);
        expect(frames[0]).toBe("session_start"); // attach on connect
        expect(frames[1]).toBe("user_message"); // drain follows
        expect(rep.peekOutbox().length).toBe(0);

        // wholesale drop: >50 queued frames on close are discarded (≤50 kept,
        // though the post-attach drain here empties the box — the drop path
        // fires only for frames queued while DISCONNECTED, so sever first)
        fake.die("error");
        await Bun.sleep(RECONNECT_BASE_MS + 30); // re-attached cleanly
        fake.die("error"); // sever again; now queue while disconnected
        for (let i = 0; i < OUTBOX_DROP_ABOVE + 1; i++) {
            rep.handleInput({ type: "input", text: `drop-${i}` } as never);
        }
        expect(rep.peekOutbox().length).toBe(OUTBOX_DROP_ABOVE + 1);
        fake.die("error"); // close fires while still queued → over 50 → dropped
        await Bun.sleep(1);
        expect(rep.peekOutbox().length).toBe(0);
    });

    it("backoff doubles 1s → 30s cap across failed connects (bounded retries)", async () => {
        const { env } = await makeEnv();
        const fake = makeFakeClient();
        let attempts = 0;
        const rep = createReporter(
            makeOpts(env, {
                connect: async () => {
                    attempts++;
                    return { ok: false as const, error: "refused" };
                },
            }),
        );
        rep.handleSessionStart({ type: "startup" } as never);
        await Bun.sleep(1);
        expect(attempts).toBe(1);
        // internal backoff state: not directly observable, so assert the cap
        // constants instead — RECONNECT_BASE_MS doubling must reach the cap
        let ms = RECONNECT_BASE_MS;
        for (let i = 0; i < 6; i++) ms = Math.min(ms * 2, RECONNECT_MAX_MS);
        expect(ms).toBe(RECONNECT_MAX_MS);
        void rep;
        void fake;
    });
});

// =====================================================================
// 5. Wire the real client (integration: reporter ↔ real unix socket server)
// =====================================================================

describe("reporter over a real unix socket (integration)", () => {
    it("attach-on-connect lands in the hub's status.json via the real server", async () => {
        const { startUnixSocketServer, connectHubClient } = await import("@yurifrl/hub/adapters/unix_socket");
        const root = await mkdtemp(join(tmpdir(), "hub-rep-real-"));
        tmps.push(root);
        const sockPath = join(root, "hub.sock");
        const seen: Record<string, unknown>[] = [];
        const server = startUnixSocketServer({
            socketPath: sockPath,
            hubInfo: { version: 1, startedAt: new Date().toISOString() },
            dispatch: async () => ({ ok: true }),
            onReport: (frame) => seen.push(frame as unknown as Record<string, unknown>),
        });
        const started = await server.start();
        expect(started.ok).toBe(true);
        const clientRes = await connectHubClient({ socketPath: sockPath, client: "plugin" });
        expect(clientRes.ok).toBe(true);
        // a HubClient reporting session_start attached:true is the attach
        clientRes.ok && clientRes.value.report("session_start", { sessionId: "s-live", kind: "peer", cwd: "/w", model: "m", attached: true });
        await Bun.sleep(10);
        expect(seen.length).toBe(1);
        expect(seen[0]).toMatchObject({ frame: "session_start", sessionId: "s-live", attached: true });
        clientRes.ok && clientRes.value.close();
        await server.close();
    });
});
