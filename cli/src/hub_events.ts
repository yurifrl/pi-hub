// cli/src/hub_events.ts — subscribed socket feed for the board family
// (docs/03-cli.md §Rendering → Re-render triggers: "EventBus push frames over
// the socket"; wire shape owned by docs/02-data-contracts.md §Event frames).
// One connection for the surface's lifetime: hello with subscribe:true →
// unsolicited `ch:"event"` frames → decoded to hub events. Reply frames are
// not expected here; cmd/reply goes through hub_socket.ts.
//
// Tests drive fake hubs through this contract (never real sockets — docs/01
// §Testing); frames are coalesced by the caller (screens) into one paint per
// batch, matching docs/03's batch-coalesce rule.

import { connect, type Socket } from "node:net";
import type { HubEventTopic } from "@yurifrl/hub";

export const PROTOCOL_VERSION = 1 as const;

/** One decoded event frame — HubEvent minus the topics the feed never emits. */
export type FeedEvent = { topic: HubEventTopic; payload: unknown };

export type HubFeed = {
  /** decoded event frames as they arrive; unsubscribe on surface exit */
  on(handler: (evt: FeedEvent) => void): () => void;
  /** socket died or hub closed the connection (also fires on clean close) */
  onClose(handler: () => void): () => void;
  /** destroy the socket; idempotent */
  close(): void;
};

/** The five reporter frame names + attention/phase per docs/02 §Event frames. */
const TOPICS: ReadonlySet<string> = new Set(["log", "status", "attention", "summary", "phase"]);

/**
 * Open a subscribed connection to hub.sock. Resolves to a live feed; hub
 * unreachable / version mismatch / handshake error → { ok:false } (the
 * surface degrades to its fallback tick, docs/03 §Refresh — watch offline is
 * a rendered state, not a crash).
 */
export const hubSubscribe = (sockPath: string): Promise<{ ok: true; feed: HubFeed } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    let settled = false;
    const socket: Socket = connect(sockPath);
    const handlers = new Set<(evt: FeedEvent) => void>();
    const closeHandlers = new Set<() => void>();
    let buffer = "";

    const finishClose = (): void => {
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
      socket.write(JSON.stringify({ v: PROTOCOL_VERSION, ch: "hello", client: "cli", subscribe: true }) + "\n");
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
          if (hub?.version !== PROTOCOL_VERSION) {
            settled = true;
            socket.destroy();
            resolve({ ok: false, error: `hub protocol version mismatch (hub v${String(hub?.version)}, client v${PROTOCOL_VERSION})` });
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
        const kind = f.kind as string;
        if (!TOPICS.has(kind)) continue;
        // docs/02 §Event frames: attention wraps its item under `item`;
        // the five reporter-name frames carry their payload fields flat
        // (sessionId, t, text, ...) — pass the frame body minus the envelope
        // keys as the payload
        const payload = kind === "attention" ? f.item : f.payload ?? (() => {
          const { v: _v, ch: _ch, kind: _k, ...rest } = f;
          void _v;
          void _ch;
          void _k;
          return rest;
        })();
        const evt: FeedEvent = { topic: kind as HubEventTopic, payload };
        for (const h of handlers) h(evt);
      }
    });
  });
