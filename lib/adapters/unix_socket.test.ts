// lib/adapters/unix_socket.test.ts — server + client over a temp socket path
// (docs/01 §Testing: unix_socket over a temp socket path; docs/02 §hub.sock).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHubClient, startUnixSocketServer } from "./unix_socket";
import type { HubSocketServer } from "./unix_socket";
import type { CommandRequest } from "../domain/command";

const tmps: string[] = [];
const servers: HubSocketServer[] = [];
const socketPath = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-sock-"));
    tmps.push(dir);
    return join(dir, "hub.sock");
};

afterAll(async () => {
    for (const s of servers) await s.close().catch(() => {});
    for (const dir of tmps) await rm(dir, { recursive: true, force: true });
});

const HUB_INFO = { version: 1, startedAt: "2026-08-30T17:42:10.113Z" };

/** Server with a scripted dispatch: echoes the op back, records requests. */
const makeServer = async () => {
    const p = await socketPath();
    const log: CommandRequest[] = [];
    const server = startUnixSocketServer({
        socketPath: p,
        hubInfo: HUB_INFO,
        dispatch: async (req) => {
            log.push(req);
            return { ok: true, result: { echoed: req.op, args: req.args } };
        },
    });
    const started = await server.start();
    if (!started.ok) throw started.error;
    servers.push(server);
    return { server, log, path: p };
};

/** Raw socket speaking one frame; collects reply frames until `want` count or timeout. */
const rawConversation = async (
    path: string,
    sentFrames: string[],
    want: number,
    timeoutMs = 1000,
): Promise<Record<string, unknown>[]> => {
    const sock = Bun.connect({
        unix: path,
        socket: {
            data(_socket, data) {
                received.push(data.toString("utf8"));
                check();
            },
            error() {},
            close() {},
        },
    });
    const received: string[] = [];
    let out: Record<string, unknown>[] = [];
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
        resolveDone = r;
    });
    const check = () => {
        const all = received.join("");
        const lines = all.split("\n").filter((l) => l.length > 0);
        out = lines.map((l) => {
            try {
                return JSON.parse(l) as Record<string, unknown>;
            } catch {
                return { ch: "unparseable" };
            }
        });
        if (out.length >= want) resolveDone();
    };
    const timer = setTimeout(resolveDone, timeoutMs);
    void (async () => {
        const s = await sock;
        for (const f of sentFrames) s.write(f + "\n");
    })();
    await done;
    clearTimeout(timer);
    (await sock).end();
    return out;
};

describe("unix_socket server — handshake (docs/02 §Handshake)", () => {
    it("client connects: hello reply carries hub meta", async () => {
        const { path } = await makeServer();
        const frames = await rawConversation(
            path,
            [JSON.stringify({ v: 1, ch: "hello", client: "cli", subscribe: false })],
            1,
        );
        expect(frames[0]?.ch).toBe("hello");
        expect((frames[0]?.hub as Record<string, unknown>)?.version).toBe(1);
        expect((frames[0]?.hub as Record<string, unknown>)?.startedAt).toBe(HUB_INFO.startedAt);
    });

    it("wrong version → bad-version error frame, connection closed after", async () => {
        const { path } = await makeServer();
        const frames = await rawConversation(
            path,
            [JSON.stringify({ v: 2, ch: "hello", client: "cli" })],
            1,
        );
        expect(frames[0]?.ch).toBe("error");
        expect((frames[0]?.error as Record<string, unknown>)?.code).toBe("bad-version");
    });
});

describe("unix_socket server — cmd/reply (docs/02 §cmd/reply frames)", () => {
    it("cmd dispatches and the reply echoes cmdId with the result", async () => {
        const { path, log } = await makeServer();
        const client = await connectHubClient({ socketPath: path, client: "cli" });
        expect(client.ok).toBe(true);
        if (!client.ok) return;
        const r = await client.value.cmd("list", { filter: "x" });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual({ echoed: "list", args: { filter: "x" } });
        expect(log).toHaveLength(1);
        expect(log[0]?.by).toBe("cli");
        client.value.close();
    });

    it("reply carries the cmdId the client minted (correlation)", async () => {
        const { path } = await makeServer();
        const client = await connectHubClient({ socketPath: path, client: "web", deadlineMs: 500 });
        if (!client.ok) return;
        // two cmds in flight; replies may arrive out of order but correlate
        const [a, b] = await Promise.all([client.value.cmd("list"), client.value.cmd("summaries")]);
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        if (a.ok) expect((a.value as Record<string, unknown>).echoed).toBe("list");
        if (b.ok) expect((b.value as Record<string, unknown>).echoed).toBe("summaries");
        client.value.close();
    });

    it("unknown op → unsolicited error frame; client surfaces unknown-op mapping", async () => {
        const { path } = await makeServer();
        const frames = await rawConversation(
            path,
            [
                JSON.stringify({ v: 1, ch: "hello", client: "cli" }),
                JSON.stringify({ v: 1, ch: "cmd", cmdId: "c1", op: "explode", args: {} }),
            ],
            2,
        );
        expect(frames[1]?.ch).toBe("error");
        expect((frames[1]?.error as Record<string, unknown>)?.code).toBe("unknown-op");
    });

    it("op deadline exceeded → reply frame with error.code timeout", async () => {
        const p = await socketPath();
        const server = startUnixSocketServer({
            socketPath: p,
            hubInfo: HUB_INFO,
            deadlineMs: 50,
            dispatch: () => new Promise(() => {}), // never resolves
        });
        const started = await server.start();
        if (!started.ok) throw started.error;
        servers.push(server);
        const client = await connectHubClient({ socketPath: p, client: "cli", deadlineMs: 1000 });
        if (!client.ok) return;
        const r = await client.value.cmd("list");
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.code).toBe("timeout");
            expect(r.error.retryable).toBe(true);
        }
    });

    it("malformed JSON → bad-frame error frame and connection closed", async () => {
        const { path } = await makeServer();
        const frames = await rawConversation(path, ["{not json"], 1);
        expect(frames[0]?.ch).toBe("error");
        expect((frames[0]?.error as Record<string, unknown>)?.code).toBe("bad-frame");
    });

    it("unknown ch → bad-frame error frame and connection closed", async () => {
        const { path } = await makeServer();
        const frames = await rawConversation(
            path,
            [JSON.stringify({ v: 1, ch: "mystery" })],
            1,
        );
        expect(frames[0]?.ch).toBe("error");
        expect((frames[0]?.error as Record<string, unknown>)?.code).toBe("bad-frame");
    });
});

describe("unix_socket server — report frames (fire-and-forget)", () => {
    it("report frames reach onReport; no reply is sent", async () => {
        const p = await socketPath();
        const got: string[] = [];
        const server = startUnixSocketServer({
            socketPath: p,
            hubInfo: HUB_INFO,
            dispatch: async () => ({ ok: true }),
            onReport: (f) => got.push(f.frame),
        });
        const started = await server.start();
        if (!started.ok) throw started.error;
        servers.push(server);
        const frames = await rawConversation(
            p,
            [
                JSON.stringify({ v: 1, ch: "hello", client: "plugin" }),
                JSON.stringify({ v: 1, ch: "report", frame: "tool_call", sessionId: "s-9f2c", tool: "bash" }),
                JSON.stringify({ v: 1, ch: "report", frame: "user_message", sessionId: "s-9f2c", text: "hi" }),
            ],
            1, // only the hello reply is expected back
        );
        expect(frames).toHaveLength(1); // no reply for report frames
        // report handler may fire after the socket closed — poll briefly
        for (let i = 0; i < 50 && got.length < 2; i++) await Bun.sleep(10);
        expect(got).toEqual(["tool_call", "user_message"]);
    });
});

describe("unix_socket server — event broadcast (docs/02 §Event frames)", () => {
    it("subscribed clients receive unsolicited event frames; unsubscribed do not", async () => {
        const { path, server } = await makeServer();
        const got: Record<string, unknown>[] = [];
        const client = await connectHubClient({ socketPath: path, client: "web", subscribe: true });
        if (!client.ok) return;
        client.value.onEvent((f) => got.push(f));
        // hello round-trip must have landed before we broadcast
        await Bun.sleep(20);
        server.broadcast({ v: 1, ch: "event", kind: "attention", item: { id: "att-6" } });
        await Bun.sleep(20);
        expect(got).toHaveLength(1);
        expect((got[0] as Record<string, unknown>)["kind"]).toBe("attention");
        client.value.close();
    });
});

describe("unix_socket server — deliverTo sessionId routing (P2-2)", () => {
    /** A raw plugin client that announces ownership via a session_start report
     * frame and collects deliver frames addressed to it. */
    const deliverClient = async (
        path: string,
        announce: string | null,
        got: { frames: Record<string, unknown>[] },
    ): Promise<void> => {
        let resolveOpen: () => void = () => {};
        const opened = new Promise<void>((r) => {
            resolveOpen = r;
        });
        const sock = Bun.connect({
            unix: path,
            socket: {
                data(_socket, data) {
                    for (const line of data.toString("utf8").split("\n")) {
                        if (!line) continue;
                        try {
                            const f = JSON.parse(line) as Record<string, unknown>;
                            if (f.ch === "deliver") got.frames.push(f);
                        } catch {
                            /* ignore */
                        }
                    }
                },
                error() {},
                close() {},
            },
        });
        void (async () => {
            const s = await sock;
            s.write(JSON.stringify({ v: 1, ch: "hello", client: "plugin" }) + "\n");
            if (announce !== null) {
                s.write(JSON.stringify({ v: 1, ch: "report", frame: "session_start", sessionId: announce, attached: true, cwd: "/w" }) + "\n");
            }
            resolveOpen();
        })();
        await opened;
    };

    it("two plugin clients: each deliver lands on the owner of the frame sessionId", async () => {
        const { server, path } = await makeServer();
        const a = { frames: [] as Record<string, unknown>[] };
        const b = { frames: [] as Record<string, unknown>[] };
        await deliverClient(path, "s-alpha", a);
        await deliverClient(path, "s-beta", b);
        // let the server accept both connections and process the ownership frames
        await Bun.sleep(50);

        // interleaved sends: routing must follow the sessionId, not the first connection
        expect(server.deliverTo("s-alpha", "hello alpha").ok).toBe(true);
        expect(server.deliverTo("s-beta", "hello beta").ok).toBe(true);
        expect(server.deliverTo("s-alpha", "again alpha").ok).toBe(true);
        await Bun.sleep(30);

        expect(a.frames.map((f) => f.text)).toEqual(["hello alpha", "again alpha"]);
        expect(b.frames.map((f) => f.text)).toEqual(["hello beta"]);
        expect(a.frames.every((f) => f.sessionId === "s-alpha")).toBe(true);
        expect(b.frames.every((f) => f.sessionId === "s-beta")).toBe(true);

        // session_end releases ownership: after it, the old owner gets nothing
        const endSock = Bun.connect({
            unix: path,
            socket: {
                data() {},
                error() {},
                close() {},
            },
        });
        void (async () => {
            const s = await endSock;
            s.write(JSON.stringify({ v: 1, ch: "hello", client: "plugin" }) + "\n");
            s.write(JSON.stringify({ v: 1, ch: "report", frame: "session_end", sessionId: "s-alpha" }) + "\n");
        })();
        await Bun.sleep(30);
        const afterEnd = server.deliverTo("s-alpha", "late");
        expect(afterEnd.ok).toBe(false);
        if (!afterEnd.ok) expect(afterEnd.error.code).toBe("unknown-session");
        expect(a.frames.map((f) => f.text)).toEqual(["hello alpha", "again alpha"]); // unchanged
    });

    it("unknown sessionId with exactly one reporter connected → unambiguous fallback", async () => {
        const { server, path } = await makeServer();
        await Bun.sleep(30);
        const only = { frames: [] as Record<string, unknown>[] };
        await deliverClient(path, null, only); // connected, owns nothing
        await Bun.sleep(30); // server must have accepted the connection first
        const r = server.deliverTo("s-never-seen", "still you");
        expect(r.ok).toBe(true);
        await Bun.sleep(30);
        expect(only.frames.map((f) => f.text)).toEqual(["still you"]);

        // with TWO reporters and no owner, routing is refused — never first-conn-wins
        const second = { frames: [] as Record<string, unknown>[] };
        await deliverClient(path, null, second);
        await Bun.sleep(30); // both reporters registered before the ambiguous send
        const refused = server.deliverTo("s-never-seen", "ambiguous");
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.code).toBe("unknown-session");
        await Bun.sleep(30);
        expect(only.frames.map((f) => f.text)).toEqual(["still you"]); // untouched
        expect(second.frames).toEqual([]);
    });
});

describe("unix_socket server — lifecycle", () => {
    it("stale socket file is unlinked before listen", async () => {
        const p = await socketPath();
        await Bun.write(p, "garbage"); // stale socket file from a crashed hub
        const server = startUnixSocketServer({ socketPath: p, hubInfo: HUB_INFO, dispatch: async () => ({ ok: true }) });
        const started = await server.start();
        expect(started.ok).toBe(true);
        servers.push(server);
        const client = await connectHubClient({ socketPath: p, client: "cli" });
        expect(client.ok).toBe(true);
        client.ok && client.value.close();
    });

    it("connect to a dead socket → unavailable-hub", async () => {
        const p = await socketPath(); // nothing listening
        const r = await connectHubClient({ socketPath: p, client: "cli" });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.code).toBe("unavailable-hub");
            // ECONNREFUSED (socket file exists, hub dead) is retryable; ENOENT (no file) is not
            expect([true, false]).toContain(r.error.retryable);
        }
    });

    it("server close removes the socket file and fails in-flight client cmds", async () => {
        const { path, server } = await makeServer();
        const client = await connectHubClient({ socketPath: path, client: "cli", deadlineMs: 2000 });
        if (!client.ok) return;
        const inflight = client.value.cmd("list");
        await server.close();
        const r = await inflight;
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("unavailable-hub");
        client.value.close();
    });
});

describe("hubCodeFor — protocol code → HubCode mapping", () => {
    // imported lazily to keep the import list at top minimal
    const { hubCodeFor } = require("./unix_socket") as typeof import("./unix_socket");
    it("maps the documented pairs", () => {
        expect(hubCodeFor("no-session")).toBe("unknown-session");
        expect(hubCodeFor("forbidden")).toBe("denied");
        expect(hubCodeFor("timeout")).toBe("timeout");
        expect(hubCodeFor("bad-frame")).toBe("unavailable-hub");
        expect(hubCodeFor("busy")).toBe("unavailable-hub");
    });
});
