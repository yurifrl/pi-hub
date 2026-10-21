// extensions/hub_sock.ts — the widget's hub.sock subscription feed (docs/05
// §Widget: data source is the hub.sock subscription; docs/02 §Event frames is
// the wire contract). Mirrors the CLI's hub.sock client-side pattern —
// hello with subscribe:true → unsolicited ch:"event" frames → raw frames to
// the caller — kept local because extensions cannot import the cli package
// (docs/01 §Import matrix); the frame decode itself lives in widget.ts so it
// stays testable without sockets.
//
// One connection per call; onClose fires on hub death/clean close so the
// owner can degrade to the offline widget state and re-enter backoff.
import { connect, type Socket } from "node:net";

export const FEED_PROTOCOL_VERSION = 1 as const;

/** A live subscribed feed of raw hub event frames (docs/02 §Event frames). */
export type HubFeedHandle = {
    /** raw ch:"event" frames as they arrive; unsubscribe returns remover */
    on(handler: (frame: Record<string, unknown>) => void): () => void;
    /** socket died or hub closed the connection (also fires on clean close) */
    onClose(handler: () => void): () => void;
    /** destroy the socket; idempotent */
    close(): void;
};

/**
 * Open a subscribed connection to hub.sock. Resolves { ok:false } when the
 * hub is unreachable, the handshake fails, or the protocol version mismatches
 * — the widget degrades to its offline state, never crashes (docs/05 §Widget,
 * docs/03 §hub watch: offline is a rendered state, not a crash).
 */
export const subscribeHubFeed = (sockPath: string): Promise<{ ok: true; feed: HubFeedHandle } | { ok: false; error: string }> =>
    new Promise((resolve) => {
        let settled = false;
        const socket: Socket = connect(sockPath);
        const handlers = new Set<(frame: Record<string, unknown>) => void>();
        const closeHandlers = new Set<() => void>();
        let buffer = "";
        let closed = false;

        const finishClose = (): void => {
            if (closed) return;
            closed = true;
            for (const h of closeHandlers) h();
        };

        socket.once("error", (err: Error) => {
            if (!settled) {
                settled = true;
                resolve({ ok: false, error: `cannot connect to hub socket at ${sockPath}: ${err.message}` });
                return;
            }
            finishClose();
        });
        socket.on("close", () => {
            if (settled) finishClose();
        });

        socket.once("connect", () => {
            socket.write(JSON.stringify({ v: FEED_PROTOCOL_VERSION, ch: "hello", client: "plugin", subscribe: true }) + "\n");
        });

        socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let idx: number;
            while ((idx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.trim().length === 0) continue;
                let frame: unknown;
                try {
                    frame = JSON.parse(line);
                } catch {
                    continue; // malformed frame — ignore, best-effort stream
                }
                const f = frame as Record<string, unknown>;
                if (!settled) {
                    if (f.ch !== "hello") {
                        settled = true;
                        socket.destroy();
                        resolve({ ok: false, error: "hub handshake failed" });
                        return;
                    }
                    const hub = f.hub as { version?: number } | undefined;
                    if (hub?.version !== FEED_PROTOCOL_VERSION) {
                        settled = true;
                        socket.destroy();
                        resolve({ ok: false, error: `hub protocol version mismatch (hub v${String(hub?.version)}, client v${FEED_PROTOCOL_VERSION})` });
                        return;
                    }
                    settled = true;
                    resolve({
                        ok: true,
                        feed: {
                            on: (h) => {
                                handlers.add(h);
                                return () => handlers.delete(h);
                            },
                            onClose: (h) => {
                                closeHandlers.add(h);
                                return () => closeHandlers.delete(h);
                            },
                            close: () => socket.destroy(),
                        },
                    });
                    continue;
                }
                if (f.ch !== "event") continue;
                for (const h of handlers) h(f);
            }
        });
    });
