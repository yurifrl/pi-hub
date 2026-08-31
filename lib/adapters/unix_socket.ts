// lib/adapters/unix_socket.ts — hub.sock server (hub process) + client (cli/web/
// plugin reporter). Port implementation; all I/O; imports ports + domain
// (docs/01-architecture.md §Package layout). Wire protocol owned by
// docs/02-data-contracts.md §hub.sock: newline-delimited JSON frames in both
// directions, one JSON object per \n-terminated frame, UTF-8, no framing
// escapes. Every frame carries v (protocol version, currently 1).

import { unlink } from "node:fs/promises";
import net from "node:net";
import { OP_NAMES, hubError } from "../domain/command";
import type { CommandRequest, HubCode, HubError, Result } from "../domain/command";

export const PROTOCOL_VERSION = 1;

/** Protocol error codes (docs/02 §Error frames) — a wider set than HubCode:
 * these travel verbatim in error/reply frames and are mapped to HubCode only
 * where a Result must be produced. */
export type ProtocolErrorCode =
    | "bad-frame"
    | "bad-version"
    | "unknown-op"
    | "forbidden"
    | "no-session"
    | "timeout"
    | "busy";

/** Map a protocol error code onto the closed HubCode taxonomy for Result values.
 * no-session → unknown-session, forbidden → denied, timeout → timeout,
 * everything else is a hub-side failure → unavailable-hub. */
export const hubCodeFor = (protocolCode: string): HubCode => {
    switch (protocolCode) {
        case "no-session":
            return "unknown-session";
        case "forbidden":
            return "denied";
        case "timeout":
            return "timeout";
        default:
            return "unavailable-hub";
    }
};

// ---- frame shapes (docs/02 §hub.sock) ----

export type HubHelloFrame = { v: number; ch: "hello"; hub: { version: number; startedAt: string } };
/** Reporter frame: `{ v, ch:"report", frame: <name>, ...payload }`, fire-and-forget. */
export type ReportFrame = { v: number; ch: "report"; frame: string } & Record<string, unknown>;
export type CmdFrame = { v: number; ch: "cmd"; cmdId: string; op: string; args?: Record<string, unknown>; by?: string };
export type ReplyFrame = {
    v: number;
    ch: "reply";
    cmdId: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
};
export type ErrorFrame = { v: number; ch: "error"; error: { code: string; message: string } };

const ok = <T>(value: T): Result<T, HubError> => ({ ok: true, value });

// ---- server ----

export type ServerOptions = {
    /** wire path for the unix socket (no default — the host resolves it) */
    socketPath: string;
    /** hub meta echoed by the hello reply (docs/02 §Handshake) */
    hubInfo: { version: number; startedAt: string };
    /** the one command surface; cmd frames dispatch here (the host adapts the
     * CommandReply Result into the {ok, result|error} wire shape) */
    dispatch: (req: CommandRequest) => Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
    /** reporter frames (ch:"report") land here — the host's event handler */
    onReport?: (frame: ReportFrame) => void;
    /** per-op deadline in ms (docs/02: 30s default; the `tool` op's 120s
     * extension is the surface's concern — it controls its own pacing) */
    deadlineMs?: number;
};

type Connection = {
    sock: net.Socket;
    /** subscribed clients receive unsolicited event frames (docs/02 §Event frames) */
    subscribed: boolean;
    /** client id from the hello frame (cli | web | plugin | agent) */
    client?: string;
    /** session ids this client is known to own (docs/02 reporter frames:
     * session_start/session_end announce ownership; used to route deliver
     * frames by sessionId instead of first-connection-wins) */
    sessions: Set<string>;
    buffer: string;
};

/** Hub-side server on a Unix domain socket. State mutations serialize through
 * `dispatch` (single-writer hub); replies correlate by cmdId and may arrive
 * out of order. Malformed input gets an error frame and closes the connection. */
export const startUnixSocketServer = (opts: ServerOptions) => {
    const deadlineMs = opts.deadlineMs ?? 30_000;
    const connections = new Set<Connection>();

    const writeFrame = (conn: Connection, frame: unknown): void => {
        try {
            conn.sock.write(JSON.stringify(frame) + "\n");
        } catch {
            // socket died mid-write; the close handler prunes the connection
        }
    };

    const sendError = (conn: Connection, code: string, message: string): void => {
        const frame: ErrorFrame = { v: PROTOCOL_VERSION, ch: "error", error: { code, message } };
        writeFrame(conn, frame);
    };

    const dispatchCmd = (conn: Connection, cmdId: string, op: string, args: Record<string, unknown>, by: CommandRequest["by"]): void => {
        const timer = setTimeout(() => {
            // op deadline exceeded (docs/02 §cmd/reply frames)
            writeFrame(conn, {
                v: PROTOCOL_VERSION,
                ch: "reply",
                cmdId,
                ok: false,
                error: { code: "timeout", message: `op ${op} exceeded ${deadlineMs}ms deadline` },
            });
        }, deadlineMs);
        opts
            .dispatch({ cmdId, op: op as CommandRequest["op"], args, by })
            .then((reply) => {
                clearTimeout(timer);
                writeFrame(conn, { v: PROTOCOL_VERSION, ch: "reply", cmdId, ...reply });
            })
            .catch((e: unknown) => {
                // surface threw — programmer error surfaced as a failed reply, hub keeps serving
                clearTimeout(timer);
                writeFrame(conn, {
                    v: PROTOCOL_VERSION,
                    ch: "reply",
                    cmdId,
                    ok: false,
                    error: { code: "bad-frame", message: `dispatch failure: ${String(e)}` },
                });
            });
    };

    const processFrame = (conn: Connection, parsed: unknown): void => {
        if (typeof parsed !== "object" || parsed === null || !("ch" in parsed)) {
            sendError(conn, "bad-frame", "frame missing ch field");
            conn.sock.end();
            return;
        }
        const frame = parsed as Record<string, unknown>;
        if (frame.v !== PROTOCOL_VERSION) {
            // major-version mismatch: error frame, then close (docs/02 §Handshake)
            sendError(conn, "bad-version", `protocol version ${JSON.stringify(frame.v)} unsupported; expected ${PROTOCOL_VERSION}`);
            conn.sock.end();
            return;
        }
        if (typeof frame.client === "string") conn.client = frame.client;
        if (frame.ch === "report" && typeof frame.sessionId === "string" && frame.sessionId.length > 0) {
            // reporter ownership: session_start/session_end move the session to
            // this connection (docs/02: frames carry sessionId on every report)
            if (frame.frame === "session_end") {
                for (const c of connections) c.sessions.delete(frame.sessionId);
            } else if (frame.frame === "session_start") {
                for (const c of connections) c.sessions.delete(frame.sessionId);
                conn.sessions.add(frame.sessionId);
            } else {
                // unknown frame name carrying a sessionId: ownership unchanged
            }
        }
        switch (frame.ch) {
            case "hello": {
                writeFrame(conn, { v: PROTOCOL_VERSION, ch: "hello", hub: opts.hubInfo });
                if (frame.subscribe === true) conn.subscribed = true;
                return;
            }
            case "report": {
                if (typeof frame.frame !== "string") {
                    sendError(conn, "bad-frame", "report frame missing frame name");
                    conn.sock.end();
                    return;
                }
                if (opts.onReport) {
                    const { ch: _ch, v: _v, ...payload } = frame;
                    opts.onReport({ ...payload, frame: frame.frame, v: PROTOCOL_VERSION, ch: "report" } as ReportFrame);
                }
                return;
            }
            case "cmd": {
                if (typeof frame.cmdId !== "string" || typeof frame.op !== "string") {
                    sendError(conn, "bad-frame", "cmd frame missing cmdId or op");
                    conn.sock.end();
                    return;
                }
                if (!(OP_NAMES as readonly string[]).includes(frame.op)) {
                    sendError(conn, "unknown-op", `unknown op: ${frame.op}`);
                    return;
                }
                const args = (frame.args ?? {}) as Record<string, unknown>;
                const by = typeof frame.by === "string" ? (frame.by as CommandRequest["by"]) : "cli";
                dispatchCmd(conn, frame.cmdId, frame.op, args, by);
                return;
            }
            default:
                // reply frames are hub→client only; anything else is a protocol error
                sendError(conn, "bad-frame", `unknown channel: ${JSON.stringify(frame.ch)}`);
                conn.sock.end();
        }
    };

    /** Frame-splitting read pump: bytes arrive in arbitrary chunks, frames end
     * at "\n". Oversized line (no newline in 1 MiB) = malformed, close. */
    const MAX_FRAME = 1024 * 1024;

    const onConnection = (sock: net.Socket): void => {
        const conn: Connection = { sock, subscribed: false, sessions: new Set(), buffer: "" };
        connections.add(conn);
        sock.on("data", (buf: Buffer) => {
            conn.buffer += buf.toString("utf8");
            for (;;) {
                const nl = conn.buffer.indexOf("\n");
                if (nl < 0) {
                    if (conn.buffer.length > MAX_FRAME) {
                        sendError(conn, "bad-frame", "frame exceeds size limit");
                        conn.sock.end();
                    }
                    return;
                }
                const line = conn.buffer.slice(0, nl);
                conn.buffer = conn.buffer.slice(nl + 1);
                if (line.length === 0) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    sendError(conn, "bad-frame", "malformed JSON frame");
                    conn.sock.end();
                    return;
                }
                processFrame(conn, parsed);
            }
        });
        sock.on("error", () => {
            /* client vanished mid-frame — prune below on close */
        });
        sock.on("close", () => {
            connections.delete(conn);
        });
    };

    const server = net.createServer(onConnection);

    /** Unsolicited event frames to subscribed clients (ch:"event"). Best-effort:
     * a dead socket's write throws into the void and the close handler prunes it. */
    const broadcast = (frame: unknown): void => {
        for (const conn of connections) {
            if (conn.subscribed) writeFrame(conn, frame);
        }
    };

    /** Push one deliver frame to the connected reporter that owns `sessionId`
     * (docs/02 §hub.sock: deliver is the reporter's one inbound mutation —
     * sendUserMessage into the host session). Routing is sessionId-addressed:
     * the connection is picked from reporter-frame ownership (session_start /
     * session_end announce it), NOT first-connection-wins — with N plugin
     * clients connected, each gets only its own session's frames. When no
     * connection owns the session but exactly one reporter is connected, it
     * is used as the unambiguous fallback. Result reports whether a live
     * connection got the frame — never a throw. */
    const deliverTo = (sessionId: string, text: string): Result<void, HubError> => {
        const reporters = [...connections].filter((c) => c.client === "plugin");
        const owner = reporters.find((c) => c.sessions.has(sessionId));
        const conn = owner ?? (reporters.length === 1 ? reporters[0] : undefined);
        if (!conn) {
            return { ok: false, error: hubError("unknown-session", `no connected reporter owns session ${sessionId}`, { retryable: false }) };
        }
        try {
            writeFrame(conn, { v: PROTOCOL_VERSION, ch: "deliver", sessionId, text });
            return ok(undefined);
        } catch (e) {
            return { ok: false, error: hubError("unavailable-hub", `deliver write failed: ${(e as Error).message}`, { retryable: true, cause: e }) };
        }
    };

    const listening = new Promise<void>((resolve) => {
        server.once("listening", () => resolve());
    });

    const start = async (socketPath?: string): Promise<Result<{ socketPath: string }, HubError>> => {
        const path = socketPath ?? opts.socketPath;
        // stale socket file from a crashed hub is unlinked before listen (docs/05 §Entry)
        try {
            await unlink(path);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                return { ok: false, error: hubError("unavailable-hub", `cannot unlink stale socket: ${code}`, { retryable: false, cause: e }) };
            }
        }
        const failed = new Promise<Result<{ socketPath: string }, HubError>>((resolve) => {
            server.once("error", (e: NodeJS.ErrnoException) => {
                resolve({ ok: false, error: hubError("unavailable-hub", `listen failed: ${e.code ?? "error"}`, { retryable: false, cause: e.code }) });
            });
        });
        server.listen(path);
        return Promise.race([failed, listening.then(() => ok({ socketPath: path }))]);
    };

    const close = async (): Promise<void> => {
        for (const conn of connections) conn.sock.destroy();
        connections.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
            await unlink(opts.socketPath);
        } catch {
            /* already gone */
        }
    };

    return { broadcast, deliverTo, start, close, server };
};

export type HubSocketServer = ReturnType<typeof startUnixSocketServer>;

// ---- client ----

export type ClientOptions = {
    socketPath: string;
    /** hello client id (docs/02: cli | web | plugin | agent) */
    client: string;
    /** opt into unsolicited event frames */
    subscribe?: boolean;
    /** default per-cmd deadline in ms (docs/02: 30s; `tool` callers pass 120s) */
    deadlineMs?: number;
};

export type HubClient = {
    /** fire-and-forget reporter frame (ch:"report", no reply, no cmdId) */
    report(frame: string, payload: Record<string, unknown>): Result<void, HubError>;
    /** one-shot cmd; resolves with the correlated reply (ok value or error Result) */
    cmd(op: string, args?: Record<string, unknown>, deadlineMs?: number): Promise<Result<unknown, HubError>>;
    /** handler for unsolicited event frames (requires subscribe:true at connect) */
    onEvent(fn: (frame: Record<string, unknown>) => void): void;
    /** graceful close; in-flight cmds fail with unavailable-hub */
    close(): void;
};

/** Connect to hub.sock and speak the frame protocol. Connection failures are
 * error Results (unavailable-hub) — nothing throws across the port boundary. */
export const connectHubClient = (opts: ClientOptions): Promise<Result<HubClient, HubError>> =>
    new Promise((resolve) => {
        const pending = new Map<string, { resolve: (r: Result<unknown, HubError>) => void; timer: NodeJS.Timeout }>();
        const eventHandlers: Array<(frame: Record<string, unknown>) => void> = [];
        let cmdSeq = 0;
        let buffer = "";
        let settled = false;
        const finish = (r: Result<HubClient, HubError>): void => {
            if (settled) return;
            settled = true;
            resolve(r);
        };

        const failAll = (error: HubError): void => {
            for (const p of pending.values()) {
                clearTimeout(p.timer);
                p.resolve({ ok: false, error });
            }
            pending.clear();
        };

        const failWith = (code: string, message: string): HubError =>
            hubError(hubCodeFor(code), message, { retryable: code === "timeout", cause: code });

        const sock = net.createConnection(opts.socketPath);

        sock.on("connect", () => {
            const hello = {
                v: PROTOCOL_VERSION,
                ch: "hello",
                client: opts.client,
                ...(opts.subscribe === true ? { subscribe: true } : {}),
            };
            sock.write(JSON.stringify(hello) + "\n");
        });

        sock.on("data", (buf: Buffer) => {
            buffer += buf.toString("utf8");
            for (;;) {
                const nl = buffer.indexOf("\n");
                if (nl < 0) break;
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.length === 0) continue;
                let frame: Record<string, unknown>;
                try {
                    frame = JSON.parse(line) as Record<string, unknown>;
                } catch {
                    continue; // never a torn frame from the hub; skip defensively
                }
                switch (frame.ch) {
                    case "hello": {
                        finish(ok(client));
                        break;
                    }
                    case "reply": {
                        const cmdId = frame.cmdId as string | undefined;
                        if (cmdId === undefined) break;
                        const p = pending.get(cmdId);
                        if (!p) break;
                        pending.delete(cmdId);
                        clearTimeout(p.timer);
                        if (frame.ok === true) {
                            p.resolve(ok(frame.result));
                        } else {
                            const e = (frame.error ?? {}) as { code?: string; message?: string };
                            p.resolve({ ok: false, error: failWith(e.code ?? "bad-frame", e.message ?? "op failed") });
                        }
                        break;
                    }
                    case "event": {
                        for (const fn of eventHandlers) fn(frame);
                        break;
                    }
                    case "error": {
                        const e = (frame.error ?? {}) as { code?: string; message?: string };
                        // protocol-level failure on this connection: fail in-flight cmds
                        failAll(failWith(e.code ?? "bad-frame", e.message ?? "protocol error"));
                        break;
                    }
                    default:
                        break;
                }
            }
        });

        sock.on("error", (e: NodeJS.ErrnoException) => {
            const error = hubError("unavailable-hub", `hub unreachable: ${e.code ?? "error"}`, {
                retryable: e.code === "ECONNREFUSED",
                cause: e.code,
            });
            failAll(error);
            finish({ ok: false, error });
        });

        sock.on("close", () => {
            failAll(hubError("unavailable-hub", "hub connection closed", { retryable: true }));
            // connection gone before hello reply: resolve the connect attempt
            finish({ ok: false, error: hubError("unavailable-hub", "hub connection closed before handshake", { retryable: true }) });
        });

        const client: HubClient = {
            report(frame, payload) {
                try {
                    const wire: Record<string, unknown> = { v: PROTOCOL_VERSION, ch: "report", frame, ...payload };
                    sock.write(JSON.stringify(wire) + "\n");
                    return ok(undefined);
                } catch (e) {
                    return { ok: false, error: hubError("unavailable-hub", `write failed: ${(e as Error).message}`, { retryable: true, cause: e }) };
                }
            },

            cmd(op, args = {}, deadline = opts.deadlineMs ?? 30_000) {
                return new Promise((res) => {
                    const cmdId = `${opts.client}-${process.pid}-${++cmdSeq}`;
                    const timer = setTimeout(() => {
                        pending.delete(cmdId);
                        res({ ok: false, error: hubError("timeout", `op ${op} timed out after ${deadline}ms`, { retryable: true }) });
                    }, deadline);
                    pending.set(cmdId, { resolve: res, timer });
                    try {
                        sock.write(JSON.stringify({ v: PROTOCOL_VERSION, ch: "cmd", cmdId, op, args }) + "\n");
                    } catch (e) {
                        clearTimeout(timer);
                        pending.delete(cmdId);
                        res({ ok: false, error: hubError("unavailable-hub", `write failed: ${(e as Error).message}`, { retryable: true, cause: e }) });
                    }
                });
            },

            onEvent(fn) {
                eventHandlers.push(fn);
            },

            close() {
                try {
                    sock.end();
                } catch {
                    /* already closed */
                }
            },
        };
    });
