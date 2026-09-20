// tests/e2e.test.ts — THE one end-to-end test (docs/01-architecture.md §Testing):
// the real composition root (extensions/hub_local.ts — json_store, jsonl_store,
// memory_bus, status attention store, watcher, unix_socket) over a temp data
// root and a real unix socket, plus two fake peer sessions speaking the
// docs/02 frame protocol on raw sockets. No pipeline mocks: the only fakes are
// the two scripted sessions and the AgentRuntime behind the brain child.
//
// Spine asserted (docs/01 §Testing):
//   1. session_start lands both sessions in status.json
//   2. prompt relay: send op → deliver frame → fake runtime answers → logs +
//      status.json reflect the round trip
//   3. tool relay: tool_call report proposes an approval AttentionItem; the
//      answer op resolves it and appends the kind:"resolution" line to
//      summaries.jsonl
//   4. status.json reflects all of it; the file is read back from disk to
//      prove the atomic rewrite landed complete
//
// Gaps noted inline, not papered over:
//   - the `tool` cmd op is not yet served by the plugin hub (hub-core routes
//     "not served"); its docs/02 error envelope is pinned so the reply shape
//     holds when the session round-trip lands
//   - peer kill/archive are worker-only today (hub-core); docs/02 consent
//     semantics for closing peer sessions are covered by their own tasks
//   - self-feed (tk-l4a, in flight by a sibling): selfSessionId resolves ""
//     in this wiring, so guard-2 is inert — both fakes use distinct session
//     ids and nothing below depends on self-feed behavior
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";

import { createHubLocal } from "../extensions/hub_local";
import type { HubLocal } from "../extensions/hub_local";
import { resolveHubEnv } from "../extensions/hub_env";
import type { AgentRuntime, StatusFile } from "@yurifrl/hub";
import { sessionHue } from "@yurifrl/hub";

// ---- helpers ----------------------------------------------------------------

/** Poll until fn returns a value; never a fixed sleep (sj9 de-flake pattern). */
const poll = async <T>(fn: () => Promise<T | null>, label: string, timeoutMs = 5_000, stepMs = 10): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value !== null) return value;
        if (Date.now() > deadline) throw new Error(`e2e poll timed out: ${label}`);
        await Bun.sleep(stepMs);
    }
};

const pollStatus = async (local: HubLocal, pred: (s: StatusFile) => boolean, label: string): Promise<StatusFile> =>
    poll(async () => {
        const snap = await local.readStatus();
        return snap.ok && pred(snap.value) ? snap.value : null;
    }, label);

const readJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
    const raw = await readFile(path, "utf8");
    return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const fileExists = async (path: string): Promise<boolean> => {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
};

// ---- fake peer session (scripted reporter over a raw socket) -----------------

type WireReply = { ok: boolean; result?: unknown; error?: { code: string; message: string } };

type FakeSession = {
    sessionId: string;
    /** every non-hello frame received (replies, delivers, errors) */
    frames: Record<string, unknown>[];
    /** fire-and-forget reporter frame (docs/02 §Reporter frames) */
    report(frame: string, payload?: Record<string, unknown>): void;
    /** correlated cmd frame → docs/02 reply envelope */
    cmd(op: string, args?: Record<string, unknown>): Promise<WireReply>;
    /** first received frame matching pred (scans backlog first, then waits) */
    nextFrame(pred: (f: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>>;
    /** the fake runtime reacts to a deliver: user turn echo + assistant answer.
     * `echoUser: false` skips the user turn (used for the approval answer, where
     * the echo would race the answer op's own resolve — docs/02 first-resolve-
     * wins — and the resolution attribution is pinned to the `answer` op). */
    receive(text: string, answer: string, opts?: { echoUser?: boolean }): void;
    close(): void;
};

const connectFakeSession = (sockPath: string, sessionId: string): Promise<FakeSession> =>
    new Promise((resolve, reject) => {
        const frames: Record<string, unknown>[] = [];
        const waiters: {
            pred: (f: Record<string, unknown>) => boolean;
            resolve: (f: Record<string, unknown>) => void;
            timer: NodeJS.Timeout;
        }[] = [];
        const pending = new Map<string, { resolve: (r: WireReply) => void; timer: NodeJS.Timeout }>();
        let seq = 0;
        let buffer = "";

        const deliverFrame = (f: Record<string, unknown>): void => {
            frames.push(f);
            for (let i = waiters.length - 1; i >= 0; i--) {
                const w = waiters[i]!;
                if (w.pred(f)) {
                    waiters.splice(i, 1);
                    clearTimeout(w.timer);
                    w.resolve(f);
                }
            }
        };

        const write = (frame: Record<string, unknown>): void => {
            sock.write(JSON.stringify(frame) + "\n");
        };

        const api: FakeSession = {
            sessionId,
            frames,
            report: (frame, payload = {}) => write({ v: 1, ch: "report", frame, sessionId, ...payload }),
            cmd: (op, args = {}) =>
                new Promise((res) => {
                    const cmdId = `${sessionId}-cmd-${++seq}`;
                    const timer = setTimeout(() => {
                        pending.delete(cmdId);
                        res({ ok: false, error: { code: "timeout", message: `no reply for ${op}` } });
                    }, 10_000);
                    pending.set(cmdId, { resolve: res, timer });
                    write({ v: 1, ch: "cmd", cmdId, op, args });
                }),
            nextFrame: (pred, label) => {
                const hit = frames.find(pred);
                if (hit) return Promise.resolve(hit);
                return new Promise((res, rej) => {
                    const timer = setTimeout(() => rej(new Error(`no ${label} frame within 5s`)), 5_000);
                    waiters.push({ pred, resolve: res, timer });
                });
            },
            receive: (text, answer, opts) => {
                if (opts?.echoUser !== false) api.report("user_message", { text });
                api.report("assistant_message", { text: answer });
            },
            close: () => sock.destroy(),
        };

        const sock: Socket = connect(sockPath);
        sock.on("error", (e: Error) => {
            reject(e);
        });
        sock.on("connect", () => {
            // docs/02 §Handshake: first frame from any client
            write({ v: 1, ch: "hello", client: "plugin" });
        });
        sock.on("data", (buf: Buffer) => {
            buffer += buf.toString("utf8");
            for (;;) {
                const nl = buffer.indexOf("\n");
                if (nl < 0) break;
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.trim().length === 0) continue;
                const f = JSON.parse(line) as Record<string, unknown>;
                if (f.ch === "hello") {
                    // handshake done: stop rejecting on later socket errors
                    sock.removeAllListeners("error");
                    sock.on("error", () => {});
                    resolve(api);
                    continue;
                }
                if (f.ch === "reply") {
                    const cmdId = f.cmdId as string;
                    const p = pending.get(cmdId);
                    if (p) {
                        pending.delete(cmdId);
                        clearTimeout(p.timer);
                        if (f.ok === true) p.resolve({ ok: true, result: f.result });
                        else p.resolve({ ok: false, error: f.error as { code: string; message: string } });
                    }
                    continue;
                }
                deliverFrame(f);
            }
        });
    });

// ---- real composition root over a temp data root -----------------------------

const bootHub = async (): Promise<{ root: string; sockPath: string; local: HubLocal; spawnCalls: string[] }> => {
    const root = await mkdtemp(join(tmpdir(), "hub-e2e-"));
    const sockPath = join(root, "hub.sock");
    const env = resolveHubEnv({ OMP_HUB_SOCK: sockPath, OMP_BIN: "omp-fake" });
    const spawnCalls: string[] = [];
    // Brain-child stand-in: the brain's real job (RPC answers) is the driven
    // child's concern, not the hub's — the hub only spawns it (docs/05 §Entry).
    const fakeRuntime: AgentRuntime = {
        spawn: async (spec) => {
            const name = spec.name ?? "worker-N";
            spawnCalls.push(name);
            return { ok: true, value: { name, sessionId: null } };
        },
        send: async () => ({ ok: true, value: undefined }),
        kill: async () => ({ ok: true, value: undefined }),
    };
    const local = createHubLocal({ env, selfSessionId: () => "", overrides: { runtime: fakeRuntime } });
    const started = await local.start();
    if (!started.ok) throw new Error(`hub failed to start: ${started.error.message}`);
    return { root, sockPath, local, spawnCalls };
};

// ---- the e2e -----------------------------------------------------------------

describe("e2e — two fake sessions over a real unix socket (docs/01 §Testing)", () => {
    const tmps: string[] = [];
    afterEach(async () => {
        for (const dir of tmps.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    it(
        "prompt in → answer out → tool call → attention → resolution → status.json reflects all of it",
        async () => {
            const hub = await bootHub();
            tmps.push(hub.root);
            const conns: { close(): void }[] = [];
            try {
                // ---- 1. handshake + session_start: both sessions land in status.json
                const alpha = await connectFakeSession(hub.sockPath, "sess-alpha");
                const bravo = await connectFakeSession(hub.sockPath, "sess-bravo");
                conns.push(alpha, bravo);

                alpha.report("session_start", {
                    attached: false,
                    cwd: hub.root,
                    model: "test-model",
                    title: "alpha fake",
                });
                bravo.report("session_start", { attached: false, cwd: hub.root, model: "test-model" });

                const roster = await pollStatus(
                    hub.local,
                    (s) => s.sessions["sess-alpha"] !== undefined && s.sessions["sess-bravo"] !== undefined,
                    "both sessions registered",
                );
                const a = roster.sessions["sess-alpha"]!;
                const b = roster.sessions["sess-bravo"]!;
                expect(a.kind).toBe("peer");
                expect(a.status).toBe("open");
                expect(a.phase).toBe("working");
                expect(a.model).toBe("test-model");
                expect(a.title).toBe("alpha fake");
                expect(a.log).toBe("logs/sess-alpha.jsonl");
                expect(a.toolCounts).toEqual({});
                expect(a.turns).toBe(0);
                expect(b.title).toBe("");

                // both session ids visible with their derived hues (theme is a pure
                // hash of the id — every surface renders these two rows distinctly)
                const hueA = sessionHue("sess-alpha");
                const hueB = sessionHue("sess-bravo");
                expect(hueA).toBeGreaterThanOrEqual(0);
                expect(hueA).toBeLessThanOrEqual(215);
                expect(hueB).toBeGreaterThanOrEqual(0);
                expect(hueB).toBeLessThanOrEqual(215);
                expect(hueA).not.toBe(hueB);

                // ---- 2. prompt relay: send op → deliver frame → fake runtime answers
                const prompt = "run the deploy and report back";
                const sendReply = await bravo.cmd("send", { sessionId: "sess-alpha", text: prompt, waitMs: 250 });
                expect(sendReply.ok).toBe(true);
                expect(sendReply.result).toEqual({ queued: true });

                const delivered = await alpha.nextFrame(
                    (f) => f.ch === "deliver" && f.text === prompt,
                    "prompt deliver",
                );
                expect(delivered.sessionId).toBe("sess-alpha");

                // the fake runtime answers exactly like the real reporter would:
                // user turn (the delivered prompt) + assistant reply
                alpha.receive(prompt, "deploy finished; all canaries green");
                await pollStatus(
                    hub.local,
                    (s) => s.sessions["sess-alpha"]!.turns === 1 && s.sessions["sess-alpha"]!.title === "alpha fake",
                    "alpha turn counted",
                );

                // the durable log holds the full exchange (docs/02 §logs)
                const alphaLog = await poll(async () => {
                    try {
                        const lines = await readJsonl(join(hub.root, "logs", "sess-alpha.jsonl"));
                        // session_start + prompt + assistant reply
                        return lines.length >= 3 ? lines : null;
                    } catch {
                        return null;
                    }
                }, "alpha log lines");
                expect(alphaLog[0]!.kind).toBe("system"); // first line is the session_start event
                const promptLine = alphaLog.find((l) => l.kind === "prompt");
                expect(promptLine).toBeDefined();
                expect(promptLine!.text).toBe(prompt);
                expect(alphaLog.some((l) => l.kind === "message" && l.text === "deploy finished; all canaries green")).toBe(true);

                // same relay for the second session — cross-direction, from alpha's
                // connection this time; bravo's title fills from its first user turn
                const bravoPrompt = "check the logs please";
                const sendReply2 = await alpha.cmd("send", { sessionId: "sess-bravo", text: bravoPrompt });
                expect(sendReply2.ok).toBe(true);
                await bravo.nextFrame((f) => f.ch === "deliver" && f.text === bravoPrompt, "bravo deliver");
                bravo.receive(bravoPrompt, "logs look clean");
                await pollStatus(
                    hub.local,
                    (s) => s.sessions["sess-bravo"]!.turns === 1 && s.sessions["sess-bravo"]!.title === bravoPrompt,
                    "bravo turn + title",
                );

                // routing is sessionId-addressed (tk-epx): each reporter got only
                // its own session's deliver
                expect(alpha.frames.filter((f) => f.ch === "deliver").length).toBe(1);
                expect(bravo.frames.filter((f) => f.ch === "deliver").length).toBe(1);

                // ---- 3. tool relay: tool_call report → approval attention → answer
                alpha.report("tool_call", { tool: "confirm", args: { action: "deploy canary 2/3" } });
                bravo.report("tool_call", { tool: "read", args: { path: "status.txt" } });

                const raised = await poll(async () => {
                    const snap = await hub.local.readStatus();
                    if (!snap.ok) return null;
                    const item = snap.value.attention.find(
                        (i) => i.sessionId === "sess-alpha" && i.kind === "approval" && i.resolvedAt === undefined,
                    );
                    const waiting = snap.value.sessions["sess-alpha"]?.phase === "waiting";
                    return item && waiting ? item : null;
                }, "approval raised + waiting phase");
                expect(raised.id).toMatch(/^att-\d+$/);
                expect(raised.text).toContain("needs approval");

                await pollStatus(
                    hub.local,
                    (s) =>
                        s.sessions["sess-alpha"]!.toolCounts["confirm"] === 1 &&
                        s.sessions["sess-bravo"]!.toolCounts["read"] === 1,
                    "tool counts",
                );

                // the attention op lists the open item (docs/02 §attention op)
                const listed = await alpha.cmd("attention", {});
                expect(listed.ok).toBe(true);
                expect((listed.result as { items: { id: string }[] }).items.some((i) => i.id === raised.id)).toBe(true);

                // consent: the answer op delivers the text, resolves the item,
                // and appends the permanent resolution line
                const answerText = "approved, proceed";
                const answerReply = await bravo.cmd("answer", { id: raised.id, text: answerText });
                expect(answerReply.ok).toBe(true);
                const resolvedItem = (answerReply.result as { item: { resolvedAt?: string; answer?: string } }).item;
                expect(typeof resolvedItem.resolvedAt).toBe("string");
                expect(resolvedItem.answer).toBe(answerText);

                await alpha.nextFrame((f) => f.ch === "deliver" && f.text === answerText, "answer deliver");
                // no user-echo here: it would race the answer op's own resolve
                // (docs/02 first-resolve-wins); attribution stays pinned to `answer`
                alpha.receive(answerText, "deploying now", { echoUser: false });

                // item off the open list, phase back to working
                await poll(async () => {
                    const l = await alpha.cmd("attention", {});
                    const items = l.ok ? (l.result as { items: unknown[] }).items : null;
                    return items !== null && items.length === 0 ? true : null;
                }, "attention list empty after resolve");
                await pollStatus(
                    hub.local,
                    (s) => s.sessions["sess-alpha"]!.phase === "working",
                    "alpha working again",
                );

                const summaries = await poll(async () => {
                    try {
                        const lines = await readJsonl(join(hub.root, "summaries.jsonl"));
                        const line = lines.find((l) => l.kind === "resolution");
                        return line ? line : null;
                    } catch {
                        return null;
                    }
                }, "resolution line");
                expect(summaries.sessionId).toBe("sess-alpha");
                expect(summaries.by).toBe("cli");
                // the id + kind ride inside the line text (docs/02 §summaries.jsonl:
                // `resolved <id> (<kind>): <answer>` via resolutionLine)
                expect(summaries.text).toBe(`resolved ${raised.id} (approval): ${answerText}`);

                // ---- 4. docs/02 reply envelopes over the real socket
                // `tool` op: not yet served by the plugin hub — the error envelope
                // is the current docs/02-shaped reply; the relay legs it will use
                // (deliver → report → reply) are exercised above
                const toolReply = await bravo.cmd("tool", {
                    sessionId: "sess-alpha",
                    tool: "bash",
                    args: { command: "echo hi" },
                });
                expect(toolReply.ok).toBe(false);
                expect(toolReply.error?.code).toBe("denied");
                expect(typeof toolReply.error?.message).toBe("string");
                // kill of a live peer now follows the docs/02 close path
                // (closing → farewell → archive → tombstone), replying after it
                const killReply = await bravo.cmd("kill", { sessionId: "sess-alpha" });
                expect(killReply.ok).toBe(true);
                // wire reply is untyped socket JSON; one named-const narrowing, then typed reads
                const killResult = killReply.result as { closedAt: string };
                expect(typeof killResult.closedAt).toBe("string");
                const killedAt = killResult.closedAt;

                // the list op: full snapshot shape (docs/02 §Ops)
                const listReply = await bravo.cmd("list", {});
                expect(listReply.ok).toBe(true);
                const snap = listReply.result as {
                    hub: { version: number };
                    sessions: Record<string, unknown>;
                    attention: unknown[];
                    archived: unknown[];
                };
                expect(snap.hub.version).toBe(1);
                expect(Object.keys(snap.sessions).sort()).toEqual(["sess-bravo"]);
                expect(Array.isArray(snap.attention)).toBe(true);
                expect(snap.archived).toEqual([{ id: "sess-alpha", path: `archive/${killedAt.slice(0, 7)}/sess-alpha.json`, closedAt: killedAt }]);

                // ---- 5. status.json reflects all of it — read back from disk
                // (the atomic rewrite landed complete; no torn file, no tmp left)
                const finalRaw = await readFile(join(hub.root, "status.json"), "utf8");
                const final = JSON.parse(finalRaw) as StatusFile;
                expect(final.version).toBe(1);
                expect(final.pid).toBe(process.pid);
                expect(Object.keys(final.sessions).sort()).toEqual(["sess-bravo"]);
                expect(final.sessions["sess-bravo"]!.toolCounts).toEqual({ read: 1 });
                expect(final.sessions["sess-bravo"]!.title).toBe(bravoPrompt);
                expect(await fileExists(join(hub.root, "status.json.tmp"))).toBe(false);

                // sess-alpha's record is on disk (docs/02 §archive): the row as
                // last seen + the close tail, immutable under archive/YYYY-MM/
                const archiveRaw = await readFile(join(hub.root, "archive", killedAt.slice(0, 7), "sess-alpha.json"), "utf8");
                const record = JSON.parse(archiveRaw) as {
                    id: string;
                    closedAt: string;
                    closedBy: string;
                    finalSummary: string;
                    version: number;
                    turns: number;
                    toolCounts: Record<string, number>;
                    phase: string;
                    description?: string;
                    log: string;
                    resolutions?: { id: string; kind: string }[];
                };
                expect(record.id).toBe("sess-alpha");
                expect(record.closedAt).toBe(killedAt);
                expect(record.closedBy).toBe("cli");
                expect(record.version).toBe(1);
                expect(record.turns).toBe(1);
                expect(record.toolCounts).toEqual({ confirm: 1 });
                expect(record.phase).toBe("working");
                expect(record.description).toBe("deploying now");
                expect(record.log).toBe("logs/sess-alpha.jsonl");
                expect(typeof record.finalSummary).toBe("string");
                // the approval item resolved earlier in this test rides along
                expect(record.resolutions?.map((r) => r.kind)).toEqual(["approval"]);

                // the brain child was spawned through the runtime (docs/05 §Entry)
                expect(hub.spawnCalls).toEqual(["brain"]);

                alpha.close();
                bravo.close();
            } finally {
                await hub.local.stop();
                for (const c of conns) c.close();
            }
        },
        30_000,
    );
});
