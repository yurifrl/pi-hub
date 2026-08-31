// web/src/routes/table.ts — the routing table (docs/04-web.md §Routes): method
// dispatch, HTML placeholders, JSON API routes writing through the command
// surface, and the /stream SSE endpoint contract.
// Pure routing over injected state + handlers; no I/O here.

import type { HubError } from "@yurifrl/hub";
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

/** Stub /stream: SSE headers + an initial snapshot event (docs/04 §SSE contract). */
const streamResponse = (snapshot: SnapshotPayload, conns: Set<SseConn>): Response => {
  const encoder = new TextEncoder();
  let closed = false;
  let closeController: (() => void) | null = null;
  const conn: SseConn = {
    close: () => {
      if (closed) return;
      closed = true;
      closeController?.();
    },
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id: string): void => {
        controller.enqueue(encoder.encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("snapshot", snapshot, "0");
      closeController = () => controller.close();
      conns.add(conn);
    },
    cancel() {
      closed = true;
      conns.delete(conn);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
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
    return streamResponse(await h.snapshot(), env.sseConns);
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
