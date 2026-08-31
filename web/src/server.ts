// web/src/server.ts — startHubWeb: the composition root of @yurifrl/hub-web
// (docs/04-web.md §Server). Bun.serve on 127.0.0.1 only (non-configurable in
// v1); subscribes to the bus on start, unsubscribes + closes all SSE
// connections on stop(). No auth in v1 (deliberate local-only tradeoff).

import { TOKEN_HEX } from "@yurifrl/hub";
import { route, type RouteHandlers } from "./routes/table";
import { buildSnapshot } from "./snapshot";
import type { HubWebDeps, HubWebTheme, SseConn } from "./types";

/** Default port (docs/04-web.md §Server; final default owned by 03-cli). */
export const DEFAULT_WEB_PORT = 7749;

const resolveTheme = (override?: HubWebTheme): HubWebTheme => ({ ...TOKEN_HEX, ...override });

export const startHubWeb = async (deps: HubWebDeps): Promise<{ stop(): Promise<void>; port: number }> => {
  const theme = resolveTheme(deps.theme);
  const sseConns = new Set<SseConn>();

  // Lifecycle: subscribe to the bus on start; unsubscribe on stop(). The web
  // surface never publishes state (docs/01 import matrix; docs/04 §Server).
  const unsubscribe = deps.bus.subscribe((_evt) => {
    // Delta fan-out over /stream (attention/log/summary/phase events) is
    // tk-szb's endpoint contract; this task ships the snapshot-only stub.
  });

  const handlers: RouteHandlers = {
    snapshot: async () => {
      const result = await deps.stores.status.read();
      if (!result.ok) throw new Error(result.error.message);
      return buildSnapshot(result.value);
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
      return route(req.method, url.pathname, { theme, sseConns }, handlers, req);
    },
  });

  return {
    port: server.port ?? deps.port ?? DEFAULT_WEB_PORT,
    stop: async () => {
      unsubscribe();
      for (const conn of sseConns) conn.close();
      sseConns.clear();
      server.stop(true);
    },
  };
};
