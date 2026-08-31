// web/src/html.ts — minimal placeholder HTML page renderers (docs/04-web.md
// §Server: server-side HTML template strings, hand-rolled, one function per
// page). Full pages belong to tk-swx/tk-nbw; these placeholders exist so the
// route table serves real 200 HTML responses while those tasks land.
// Pure string building; no I/O.

import type { HubWebTheme, SnapshotPayload, SessionDigest } from "./types";

/** CSP for every HTML page (docs/04-web.md §Server static assets). */
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

/** One inline <style> from lib theme tokens; the web package never hardcodes a hex. */
const style = (theme: HubWebTheme): string =>
  `<style>:root{${Object.entries(theme)
    .map(([token, hex]) => `--${token}: ${hex};`)
    .join("")}}body{font-family:ui-monospace,monospace}</style>`;

const sessionLine = (s: SessionDigest): string =>
  `<li><a href="/session/${s.id}">${s.id}</a> · ${s.session.phase} · ${s.session.title}</li>`;

const sessionsList = (snapshot: SnapshotPayload): string => {
  if (snapshot.sessions.length === 0) return "<p>no open sessions</p>";
  return `<ul>${snapshot.sessions.map(sessionLine).join("")}</ul>`;
};

const attentionList = (snapshot: SnapshotPayload): string => {
  if (snapshot.attention.length === 0) return "<p>nothing needs you</p>";
  return `<ul>${snapshot.attention
    .map(
      (item) =>
        `<li data-item="${item.id}"><a href="/session/${item.sessionId}">${item.kind}</a> · ${item.text} ` +
        `<a href="/session/${item.sessionId}">→</a></li>`,
    )
    .join("")}</ul>`;
};

/** GET / — attention console (placeholder; real renderer: tk-swx). */
export const consolePage = (snapshot: SnapshotPayload, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub console</title>${style(theme)}</head><body>` +
  `<h1>hub console</h1><p>${snapshot.digest}</p>` +
  `<h2>needs you</h2>${attentionList(snapshot)}` +
  `<h2>sessions</h2>${sessionsList(snapshot)}` +
  `<p><a href="/agent">agent</a> · <a href="/archive">archive</a></p>` +
  `</body></html>`;

/** GET /session/:id — session detail (placeholder; real renderer: tk-swx). */
export const sessionPage = (id: string, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · ${id}</title>${style(theme)}</head><body>` +
  `<h1>session ${id}</h1><p>full session detail renderer pending (tk-swx)</p>` +
  `<p><a href="/">← console</a></p></body></html>`;

/** GET /agent — hub-agent surface registry (placeholder; real renderer: tk-nbw). */
export const agentPage = (theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub agent</title>${style(theme)}</head><body>` +
  `<h1>hub agent</h1><p>no hub agent running — start with <code>hub agent</code></p>` +
  `<p><a href="/">← console</a></p></body></html>`;

/** GET /archive — index of closed sessions (placeholder; real renderer: tk-nbw). */
export const archivePage = (theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub archive</title>${style(theme)}</head><body>` +
  `<h1>archive</h1><p>no archived sessions</p>` +
  `<p><a href="/">← console</a></p></body></html>`;

/** GET /archive/:id — archived session detail (placeholder; real renderer: tk-nbw). */
export const archivedSessionPage = (id: string, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · ${id}</title>${style(theme)}</head><body>` +
  `<h1>archived session ${id}</h1><p>archived detail renderer pending (tk-nbw)</p>` +
  `<p><a href="/archive">← archive</a></p></body></html>`;

/** 404 page for unknown session ids — lists open sessions (docs/04 §Routes). */
export const sessionNotFoundPage = (snapshot: SnapshotPayload, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · not found</title>${style(theme)}</head><body>` +
  `<h1>session not found</h1>${sessionsList(snapshot)}` +
  `<p><a href="/">← console</a></p></body></html>`;
