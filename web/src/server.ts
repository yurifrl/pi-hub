// web/src/server.ts — startHubWeb: the composition root of @yurifrl/hub-web
// (docs/04-web.md §Server). Bun.serve on 127.0.0.1 only (non-configurable in
// v1); subscribes to the bus on start, unsubscribes + closes all SSE
// connections on stop(). No auth in v1 (deliberate local-only tradeoff).

import { TOKEN_HEX } from "@yurifrl/hub";
import { createSseBus } from "@yurifrl/hub/adapters/sse_bus";
import { route, type RouteHandlers } from "./routes/table";
import { buildSnapshot } from "./snapshot";
import { sseEventsFor } from "./sse";
import type { HubWebDeps, HubWebTheme, SseConn } from "./types";

/** Default port (docs/04-web.md §Server; final default owned by 03-cli). */
export const DEFAULT_WEB_PORT = 7749;

const resolveTheme = (override?: HubWebTheme): HubWebTheme => ({ ...TOKEN_HEX, ...override });

export const startHubWeb = async (deps: HubWebDeps): Promise<{ stop(): Promise<void>; port: number }> => {
  const theme = resolveTheme(deps.theme);
  const sseConns = new Set<SseConn>();
  // the delta side of /stream (docs/04 §SSE contract); web is the transport
  // host, the sse_bus adapter is the numbered-ring + replay mechanism
  const bus = createSseBus();

  // Lifecycle: subscribe to the hub event bus on start; unsubscribe on stop().
  // The web surface never publishes state (docs/01 import matrix). Each
  // committed hub event becomes the smallest-describing /stream delta (docs/04
  // §SSE contract); snapshot-material events are dropped here and covered by
  // the fresh snapshot every connect/reconnect serves.
  const unsubscribe = deps.bus.subscribe((evt) => {
    for (const sse of sseEventsFor(evt)) {
      bus.publish({ topic: sse.event, payload: sse.payload });
    }
  });

  const handlers: RouteHandlers = {
    snapshot: async () => {
      const result = await deps.stores.status.read();
      if (!result.ok) throw new Error(result.error.message);
      return buildSnapshot(result.value);
    },
    summaries: async () => {
      // tail summaries.jsonl, newest first for the rail (docs/04 §Main page 6)
      const result = await deps.stores.summaries.tail(30);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.slice().reverse();
    },
    answer: async (itemId, text) => {
      const reply = await deps.commands.dispatch({ cmdId: crypto.randomUUID(), op: "answer", args: { id: itemId, text }, by: "web" });
      return reply.ok ? null : reply.error;
    },
    assign: async (sessionId, task) => {
      const reply = await deps.commands.dispatch({ cmdId: crypto.randomUUID(), op: "assign", args: { id: sessionId, task }, by: "web" });
      return reply.ok ? null : reply.error;
    },
    send: async (sessionId, text) => {
      const reply = await deps.commands.dispatch({ cmdId: crypto.randomUUID(), op: "send", args: { target: sessionId, text }, by: "web" });
      return reply.ok ? null : reply.error;
    },
    dismiss: async (itemId) => {
      const reply = await deps.commands.dispatch({ cmdId: crypto.randomUUID(), op: "attention", args: { action: "dismiss", id: itemId }, by: "web" });
      return reply.ok ? null : reply.error;
    },
  };

  const server = Bun.serve({
    // Bind 127.0.0.1 ONLY — non-configurable in v1 (docs/04-web.md §Server).
    hostname: "127.0.0.1",
    port: deps.port ?? DEFAULT_WEB_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      return route(req.method, url.pathname, { theme, bus, sseConns }, handlers, req);
    },
  });

  return {
    port: server.port ?? deps.port ?? DEFAULT_WEB_PORT,
    stop: async () => {
      unsubscribe();
      for (const conn of sseConns) conn.close();
      sseConns.clear();
      // yield one tick so the closed streams flush their FIN before the
      // forced stop resets any straggler socket (graceful close, then sweep)
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.stop(true);
    },
  };
};
