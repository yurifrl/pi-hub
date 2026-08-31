// web/src/routes/table.ts — the routing table (docs/04-web.md §Routes): method
// dispatch, HTML placeholders, JSON API routes writing through the command
// surface, and the /stream SSE endpoint contract.
// Pure routing over injected state + handlers; no I/O here.

import type { HubError } from "@yurifrl/hub";
import { formatSse, type SseBus, type SseMessage } from "@yurifrl/hub/adapters/sse_bus";
import { CSP, agentPage, archivedSessionPage, archivePage, consolePage, sessionNotFoundPage, sessionPage } from "../html";
import type { HubWebTheme, SseConn, SnapshotPayload } from "../types";

// ---- shared handlers passed in by server.ts (I/O lives there) ----

export type RouteHandlers = {
  /** current StatusFile for HTML renders and /api/status */
  snapshot(): Promise<SnapshotPayload>;
  /** POST /api/answer {itemId, text} — deliver text to session + resolve item */
  answer(itemId: string, text: string): Promise<HubError | null>;
  /** POST /api/assign {sessionId, task} */
  assign(sessionId: string, task: string): Promise<HubError | null>;
  /** POST /api/send {sessionId, text} */
  send(sessionId: string, text: string): Promise<HubError | null>;
  /** POST /api/dismiss {itemId} */
  dismiss(itemId: string): Promise<HubError | null>;
};

export type RouteEnv = {
  theme: HubWebTheme;
  /** delta replay + live fan-out for /stream (docs/04 §SSE contract) */
  bus: SseBus;
  /** open SSE connections, closed on server stop() */
  sseConns: Set<SseConn>;
};

// ---- HTTP responses ----

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP },
  });

const ok = (): Response => json({ ok: true }, 200);

/** Map the closed HubError taxonomy to HTTP status + body (docs/04 §Routes). */
const errorJson = (err: HubError): Response =>
  json({ error: err.message }, err.code === "unknown-session" ? 404 : err.code === "denied" ? 409 : 502);

/** What a connection needs to serve `GET /stream` (docs/04 §SSE contract):
 * delta replay + live fan-out from the bus adapter, and the open-connection
 * registry so stop() can close every stream. */
export type StreamContext = {
  bus: SseBus;
  /** open SSE connections, closed on server stop() */
  conns: Set<SseConn>;
};

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/** The snapshot provider the stream reads state from at connect/reconnect. */
type SnapshotHandler = () => Promise<SnapshotPayload>;

/**
 * `GET /stream` — one logical SSE channel (docs/04-web.md §SSE contract).
 * First event is always a fresh `snapshot`. A `Last-Event-ID` reattach gets
 * the ring replay (deltas keep their original ids) followed by a fresh
 * snapshot; a reattach that missed beyond the ring, sent no id, or sent a
 * garbage id gets the snapshot only — designed degrade (docs/04 §Reconnect
 * semantics). Deltas are idempotent: keyed by item id / session id, so
 * re-applying is safe. Snapshot events are unnumbered, so the client's
 * Last-Event-ID never lands on a snapshot and re-delivery stays idempotent.
 */
const streamResponse = (request: Request, stream: StreamContext, snapshot: SnapshotHandler): Response => {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const conn: SseConn = {
    close: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by cancel/teardown
        }
      };
      conn.close = () => {
        close();
        unsubscribe?.();
        unsubscribe = null;
      };
      const send = (m: SseMessage): void => {
        controller.enqueue(encoder.encode(formatSse(m)));
      };
      try {
        // EventSource sends the last seen id as a header; a raw reconnect may
        // pass it as a query param instead — both are honored.
        const lastId =
          request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("lastEventId") ?? undefined;
        for (const m of stream.bus.replay(lastId)) send(m);
        // fresh snapshot after the replay — or alone on a degraded reattach
        send({ event: "snapshot", data: JSON.stringify(await snapshot()) });
      } catch {
        // snapshot read failed before the stream could be established
        controller.close();
        return;
      }
      unsubscribe = stream.bus.onMessage((m) => {
        try {
          send(m);
        } catch {
          // consumer gone: prune + stop delivering
          stream.conns.delete(conn);
          conn.close();
        }
      });
      stream.conns.add(conn);
    },
    cancel() {
      stream.conns.delete(conn);
      unsubscribe?.();
      unsubscribe = null;
      conn.close = () => {}; // idempotent no-op after cancel
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
};

const notFound = (what: string): Response => json({ error: what }, 404);

// ---- API request bodies ----

export type AnswerBody = { itemId: string; text: string };
export type AssignBody = { sessionId: string; task: string };
export type SendBody = { sessionId: string; text: string };
export type DismissBody = { itemId: string };

// ---- route table ----

export const route = async (
  method: string,
  pathname: string,
  env: RouteEnv,
  h: RouteHandlers,
  request: Request,
): Promise<Response> => {
  const methodMismatch = (allowed: string): Response =>
    new Response(null, { status: 405, headers: { allow: allowed } });

  // HTML routes
  if (method === "GET") {
    if (pathname === "/") {
      return html(consolePage(await h.snapshot(), env.theme), 200);
    }
    const session = pathname.match(/^\/session\/([^/]+)$/);
    if (session) {
      const id = decodeURIComponent(session[1]!);
      const snapshot = await h.snapshot();
      const known = snapshot.sessions.some((s: { id: string }) => s.id === id);
      return known
        ? html(sessionPage(id, env.theme), 200)
        : html(sessionNotFoundPage(snapshot, env.theme), 404);
    }
    if (pathname === "/agent") return html(agentPage(env.theme), 200);
    if (pathname === "/archive") return html(archivePage(env.theme), 200);
    const archive = pathname.match(/^\/archive\/([^/]+)$/);
    if (archive) return html(archivedSessionPage(decodeURIComponent(archive[1]!), env.theme), 200);
  }

  // API routes — JSON in/out, writes through the command surface
  if (method === "POST" && (pathname === "/api/answer" || pathname === "/api/assign" || pathname === "/api/send" || pathname === "/api/dismiss")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "malformed JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) return json({ error: "malformed JSON body" }, 400);
    const b = body as Record<string, unknown>;

    switch (pathname) {
      case "/api/answer": {
        const { itemId, text } = b as Partial<AnswerBody>;
        if (typeof itemId !== "string") return json({ error: "missing itemId" }, 400);
        if (typeof text !== "string") return json({ error: "missing text" }, 400);
        const err = await h.answer(itemId, text);
        return err ? errorJson(err) : ok();
      }
      case "/api/assign": {
        const { sessionId, task } = b as Partial<AssignBody>;
        if (typeof sessionId !== "string") return json({ error: "missing sessionId" }, 400);
        if (typeof task !== "string") return json({ error: "missing task" }, 400);
        const err = await h.assign(sessionId, task);
        return err ? errorJson(err) : ok();
      }
      case "/api/send": {
        const { sessionId, text } = b as Partial<SendBody>;
        if (typeof sessionId !== "string") return json({ error: "missing sessionId" }, 400);
        if (typeof text !== "string") return json({ error: "missing text" }, 400);
        const err = await h.send(sessionId, text);
        return err ? errorJson(err) : ok();
      }
      case "/api/dismiss": {
        const { itemId } = b as Partial<DismissBody>;
        if (typeof itemId !== "string") return json({ error: "missing itemId" }, 400);
        const err = await h.dismiss(itemId);
        return err ? errorJson(err) : ok();
      }
    }
  }

  if (method === "GET" && pathname === "/api/status") {
    return json(await h.snapshot(), 200);
  }

  if (method === "GET" && pathname === "/stream") {
    return streamResponse(request, { bus: env.bus, conns: env.sseConns }, h.snapshot);
  }

  // method mismatch on a known path → 405 with Allow (sensible mismatch behavior)
  const knownPath =
    pathname === "/" ||
    pathname === "/agent" ||
    pathname === "/archive" ||
    pathname === "/api/status" ||
    pathname === "/stream" ||
    /^\/session\/[^/]+$/.test(pathname) ||
    /^\/archive\/[^/]+$/.test(pathname) ||
    ["/api/answer", "/api/assign", "/api/send", "/api/dismiss"].includes(pathname);
  if (knownPath) {
    const postOnly = ["/api/answer", "/api/assign", "/api/send", "/api/dismiss"].includes(pathname);
    return methodMismatch(postOnly ? "POST" : "GET");
  }

  return notFound("not found");
};
