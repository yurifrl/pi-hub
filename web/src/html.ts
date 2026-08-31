// web/src/html.ts — server-side HTML template strings, one function per page
// (docs/04-web.md §Server: hand-rolled, no framework, no client bundle).
// The console page is the real renderer (tk-swx); the other pages remain
// placeholders for tk-nbw. Pure string building; no I/O.

import type { AttentionItem, SummaryLine } from "@yurifrl/hub";
import { hueVars } from "./hue";
import { sessionsByPhase } from "./snapshot";
import type { HubWebTheme, SnapshotPayload, SessionDigest } from "./types";

/** CSP for every HTML page (docs/04-web.md §Server static assets). */
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

// ---- shared helpers ----

/** HTML-escape interpolated strings — every piece of page text goes through these. */
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Theme token vars + per-session hue vars → one inline <style>. lib owns the palette. */
const style = (theme: HubWebTheme, hueCss: string): string =>
  `<style>:root{${Object.entries(theme)
    .map(([token, hex]) => `--${token}: ${hex};`)
    .join("")}${hueCss}}
body{font-family:ui-monospace,monospace;background:var(--muted);color:rgba(255,255,255,.87);margin:0;padding:1rem}
[hidden]{display:none!important}
a{color:var(--accent);text-decoration:none}
header{display:flex;gap:1rem;align-items:baseline}header h1{font-size:1.1rem;margin:0}header nav{margin-left:auto}
#filter{background:rgba(0,0,0,.6);color:inherit;border:1px solid var(--muted);border-radius:4px;padding:2px 6px}
#digest{color:var(--accent)}
.columns{display:grid;grid-template-columns:1fr 18rem;gap:1rem;align-items:start}
main{min-width:0}aside{border-left:1px solid var(--muted);padding-left:1rem}
.card{border:1px solid var(--muted);border-left:3px solid var(--warn);border-radius:6px;padding:.5rem .75rem;margin:.5rem 0;background:rgba(0,0,0,.35)}
.card.warn-border{border-left-color:var(--warn)}
.card header{display:flex;gap:.5rem;align-items:center}.card header .verb{margin-left:auto}
.card header .verb + .verb{margin-left:0}
.hue{display:inline-block;width:.55em;height:1em;border-radius:2px;vertical-align:text-bottom}
.chip{color:var(--warn);white-space:nowrap}
.sid{color:var(--muted)}
.verb{background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;padding:0 2px}
.inline-form{display:flex;gap:.5rem;align-items:center}
.inline-form input{flex:1;background:rgba(0,0,0,.5);color:inherit;border:1px solid var(--muted);border-radius:4px;padding:2px 6px}
.hint{color:var(--muted);font-size:.85em}
.strip-line{display:flex;gap:.5rem;align-items:center;padding:.15rem 0}
.strip-line .verb{margin-left:auto}
.phase{min-width:4.5rem}.phase-working{color:var(--ok)}.phase-waiting{color:var(--warn)}.phase-blocked{color:var(--err)}.phase-idle{color:var(--muted)}
.desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.summary-line{display:flex;gap:.4rem;align-items:center;padding:.15rem 0;overflow:hidden}
.summary-line a{color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.summary-line.resolution a{color:var(--ok)}
.stream-log{max-height:12rem;overflow-y:auto;background:rgba(0,0,0,.5);border:1px solid var(--muted);border-radius:6px;padding:.5rem}
.log-line{white-space:pre-wrap;word-break:break-word}
.empty{color:var(--muted)}
.keys{color:var(--muted);font-size:.85em}
</style>`;

/** Attention kind → chip glyph (docs/04 §Main page 2 + wireframe). */
const KIND_GLYPH: Record<AttentionItem["kind"], string> = { approval: "⚠", question: "?", blocked: "⛔", idle: "💤" };

/** Millis → compact human duration (`45s`, `12m`, `3h`, `2d`); floors, never negative. */
export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

// ---- console page (GET / — the attention console, docs/04 §Main page) ----

/** Filter haystack attribute — matching is lowercase substring over this. */
const filterAttr = (haystack: string): string => ` data-filter="${esc(haystack.toLowerCase())}"`;

/** Hue bar span for a session id (per-session `--hue-<id>` var). */
const hueBar = (sessionId: string): string => `<span class="hue" style="background:var(--hue-${esc(sessionId)})"></span>`;

/** Attention card: kind chip, hue bar + id, text, three verbs (answer input, dismiss ✕, open →). */
const attentionCard = (item: AttentionItem): string =>
  `<article class="card attention warn-border" data-item="${esc(item.id)}"${filterAttr(`${item.kind} ${item.sessionId} ${item.text}`)}>` +
  `<header><span class="chip" data-kind="${item.kind}">${KIND_GLYPH[item.kind]} ${item.kind}</span>` +
  `${hueBar(item.sessionId)}<span class="sid">${esc(item.sessionId)}</span>` +
  `<button class="verb dismiss" data-dismiss="${esc(item.id)}" title="dismiss">✕</button>` +
  `<a class="verb" href="/session/${esc(item.sessionId)}" title="open">→</a></header>` +
  `<p>${esc(item.text)}</p>` +
  `<form class="inline-form" data-answer="${esc(item.id)}"><input name="text" placeholder="answer" autocomplete="off">` +
  `<span class="hint">⏎ answers</span></form></article>`;

/** Running-strip line: hue bar, phase word, description, link; waiting lines carry the attention count. */
const runningLine = (s: SessionDigest, attentionCount: number): string =>
  `<div class="strip-line" data-session="${esc(s.id)}"${filterAttr(`${s.session.phase} ${s.session.description ?? s.session.title}`)}>` +
  `${hueBar(s.id)}<span class="phase phase-${s.session.phase}">${s.session.phase}</span>` +
  `<span class="desc">${s.session.phase === "waiting" && attentionCount > 0 ? `${attentionCount} attention · ` : ""}${esc(s.session.description ?? s.session.title)}</span>` +
  `<a class="verb" href="/session/${esc(s.id)}">→</a></div>`;

/** Idle-assign card: hue bar, id, idle-for duration, assign input on the card. */
const idleCard = (s: SessionDigest, idleFor: string): string =>
  `<article class="card idle-card" data-session="${esc(s.id)}"${filterAttr(`idle ${s.id} ${s.session.title}`)}>` +
  `${hueBar(s.id)}<span class="sid">${esc(s.id)}</span>` +
  `<span class="idle-for">idle ${esc(idleFor)}</span>` +
  `<form class="inline-form" data-assign="${esc(s.id)}"><input name="task" placeholder="assign:" autocomplete="off"></form></article>`;

/** Summary-rail line: per-session tinted, newest first, links to /session/:id. */
const summaryLine = (line: SummaryLine): string =>
  `<div class="summary-line${line.kind === "resolution" ? " resolution" : ""}"${filterAttr(line.text)}>` +
  `${hueBar(line.sessionId)}<a href="/session/${esc(line.sessionId)}">${esc(line.text)}</a></div>`;

/**
 * Client script — snapshot cache + SSE deltas + the three verbs + keyboard +
 * filter (docs/04 §Client state). Rendered against the documented /stream
 * event shapes (snapshot/attention/log/summary/phase); the page boots from a
 * server-rendered DOM and re-renders from state on every delta.
 */
const consoleScript = (snapshot: SnapshotPayload): string => {
  // Embed the snapshot as JSON; escape `<` so `</script>` inside session text
  // cannot close the element (docs/04 §Server: inline script is deliberate).
  const boot = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  return `<script>
(() => {
  // ---- state: the snapshot is authoritative; deltas are idempotent ----
  let state = ${boot};
  let streamOpen = false;
  let focusIndex = -1;
  const logRing = []; // bounded ring of log events, oldest dropped
  const summaries = []; // newest first

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const hueVar = (id) => "var(--hue-" + id + ")";
  const chip = (kind) => ({ approval: "\\u26a0", question: "?", blocked: "\\u26d4", idle: "\\ud83d\\udca4" })[kind] + " " + kind;
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  };

  const logLine = (entry) =>
    '<div class="log-line"><span class="hue" style="background:' + hueVar(entry.sessionId) + '"></span>' + escapeHtml(entry.text) + "</div>";

  const renderStream = () => {
    const chipEl = document.getElementById("stream-chip");
    chipEl.textContent = (streamOpen ? "\\u25be " : "\\u25b8 ") + "stream (" + logRing.length + ")";
    const el = document.getElementById("stream-log");
    el.innerHTML = logRing.map(logLine).join("");
    el.scrollTop = el.scrollHeight; // newest at bottom
  };

  const renderAttention = () =>
    state.attention.map((item) =>
      '<article class="card attention warn-border" data-item="' + escapeHtml(item.id) + '" data-filter="' + escapeHtml((item.kind + " " + item.sessionId + " " + item.text).toLowerCase()) + '">' +
      '<header><span class="chip" data-kind="' + item.kind + '">' + chip(item.kind) + "</span>" +
      '<span class="hue" style="background:' + hueVar(item.sessionId) + '"></span><span class="sid">' + escapeHtml(item.sessionId) + "</span>" +
      '<button class="verb dismiss" data-dismiss="' + escapeHtml(item.id) + '" title="dismiss">\\u2715</button>' +
      '<a class="verb" href="/session/' + encodeURIComponent(item.sessionId) + '" title="open">\\u2192</a></header>' +
      "<p>" + escapeHtml(item.text) + "</p>" +
      '<form class="inline-form" data-answer="' + escapeHtml(item.id) + '"><input name="text" placeholder="answer" autocomplete="off"><span class="hint">\\u23ce answers</span></form></article>').join("");

  const renderRunning = () => {
    const counts = {};
    for (const item of state.attention) counts[item.sessionId] = (counts[item.sessionId] || 0) + 1;
    const running = state.sessions.filter((s) => s.session.phase !== "idle");
    return running.map((s) =>
      '<div class="strip-line" data-session="' + escapeHtml(s.id) + '" data-filter="' + escapeHtml((s.session.phase + " " + (s.session.description || s.session.title)).toLowerCase()) + '">' +
      '<span class="hue" style="background:' + hueVar(s.id) + '"></span>' +
      '<span class="phase phase-' + s.session.phase + '">' + s.session.phase + "</span>" +
      '<span class="desc">' + (s.session.phase === "waiting" && counts[s.id] ? counts[s.id] + " attention \\u00b7 " : "") + escapeHtml(s.session.description || s.session.title) + "</span>" +
      '<a class="verb" href="/session/' + encodeURIComponent(s.id) + '">\\u2192</a></div>').join("");
  };

  const renderIdle = () => {
    const idle = state.sessions.filter((s) => s.session.phase === "idle");
    return idle.map((s) =>
      '<article class="card idle-card" data-session="' + escapeHtml(s.id) + '" data-filter="' + escapeHtml(("idle " + s.id + " " + s.session.title).toLowerCase()) + '">' +
      '<span class="hue" style="background:' + hueVar(s.id) + '"></span><span class="sid">' + escapeHtml(s.id) + "</span>" +
      '<span class="idle-for">idle ' + fmtDur(Date.now() - Date.parse(s.session.lastActivity)) + "</span>" +
      '<form class="inline-form" data-assign="' + escapeHtml(s.id) + '"><input name="task" placeholder="assign:" autocomplete="off"></form></article>').join("");
  };

  const renderSummaries = () =>
    summaries.map((line) =>
      '<div class="summary-line' + (line.kind === "resolution" ? " resolution" : "") + '" data-filter="' + escapeHtml(line.text.toLowerCase()) + '">' +
      '<span class="hue" style="background:' + hueVar(line.sessionId) + '"></span>' +
      '<a href="/session/' + encodeURIComponent(line.sessionId) + '">' + escapeHtml(line.text) + "</a></div>").join("");

  // every render is a pure function of state (docs/04 §Client state)
  const render = () => {
    document.getElementById("digest").textContent = state.digest;
    // agent-off fallback: hide the attention + summary rails, stream-only mode
    const agentOn = state.agentOn !== false;
    document.getElementById("needs-you").hidden = !agentOn;
    document.getElementById("summary-rail").hidden = !agentOn;
    document.getElementById("agent-state").textContent = agentOn ? "○ agent on" : "○ agent off";
    document.getElementById("attention-list").innerHTML =
      state.attention.length ? renderAttention() : '<p class="empty">nothing needs you</p>';
    document.getElementById("running-list").innerHTML =
      renderRunning() || '<p class="empty">nothing running</p>';
    document.getElementById("idle-list").innerHTML =
      renderIdle() || '<p class="empty">no idle sessions</p>';
    document.getElementById("summary-list").innerHTML =
      renderSummaries() || '<p class="empty">no summaries yet</p>';
    renderStream();
    applyFilter();
  };

  // ---- SSE deltas (docs/04 §SSE contract shapes) ----
  const applyAttention = (d) => {
    if (d.op === "raised") {
      state.attention = state.attention.filter((i) => i.id !== d.item.id);
      state.attention.push(d.item);
    } else {
      state.attention = state.attention.filter((i) => i.id !== d.item.id);
      summaries.unshift({ t: d.item.resolvedAt || new Date().toISOString(), sessionId: d.item.sessionId, kind: "resolution", text: "resolved " + d.item.id + " (" + d.item.kind + "): " + (d.item.answer ?? "dismissed"), by: "web" });
    }
    render();
  };
  const applyLog = (d) => {
    logRing.push(d.entry);
    if (logRing.length > 500) logRing.shift();
    renderStream(); // the stream keeps buffering even while collapsed
  };
  const applySummary = (d) => { summaries.unshift(d); render(); };
  const applyPhase = (d) => {
    const rec = state.sessions.find((s) => s.id === d.sessionId);
    if (rec) {
      rec.session.phase = d.phase;
      if (d.description !== undefined) rec.session.description = d.description;
    }
    if (d.digest !== undefined) state.digest = d.digest;
    render();
  };

  if ("EventSource" in window) {
    const es = new EventSource("/stream");
    es.addEventListener("snapshot", (e) => { state = JSON.parse(e.data); render(); });
    es.addEventListener("attention", (e) => applyAttention(JSON.parse(e.data)));
    es.addEventListener("log", (e) => applyLog(JSON.parse(e.data)));
    es.addEventListener("summary", (e) => applySummary(JSON.parse(e.data)));
    es.addEventListener("phase", (e) => applyPhase(JSON.parse(e.data)));
  }

  // ---- actions: answer / assign (submit), dismiss ✕ / stream chip (click) ----
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form");
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector("input");
    const text = input ? input.value.trim() : "";
    if (form.dataset.answer && text) { post("/api/answer", { itemId: form.dataset.answer, text: text }); input.value = ""; }
    if (form.dataset.assign && text) { post("/api/assign", { sessionId: form.dataset.assign, task: text }); input.value = ""; }
  });
  document.addEventListener("click", (e) => {
    const dismiss = e.target.closest("[data-dismiss]");
    if (dismiss) post("/api/dismiss", { itemId: dismiss.dataset.dismiss });
    if (e.target.closest("#stream-chip")) {
      streamOpen = !streamOpen; // toggling sends no request — log events keep buffering
      document.getElementById("stream-panel").hidden = !streamOpen;
      renderStream();
    }
  });

  // ---- keyboard: a next attention input, s stream, / filter, Esc blurs ----
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (document.activeElement) document.activeElement.blur(); focusIndex = -1; return; }
    const tag = document.activeElement ? document.activeElement.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA") return; // Enter submits natively while typing
    if (e.key === "a" && !e.metaKey && !e.ctrlKey) {
      const inputs = document.querySelectorAll("#attention-list form[data-answer] input");
      if (inputs.length) { focusIndex = (focusIndex + 1) % inputs.length; inputs[focusIndex].focus(); }
      e.preventDefault();
    }
    if (e.key === "s") document.getElementById("stream-chip").click();
    if (e.key === "/") { document.getElementById("filter").focus(); e.preventDefault(); }
  });

  // ---- filter: hides non-matching cards + strip lines, client-side only ----
  const applyFilter = () => {
    const q = document.getElementById("filter").value.trim().toLowerCase();
    for (const el of document.querySelectorAll("[data-filter]"))
      el.hidden = q !== "" && !el.dataset.filter.includes(q);
  };
  document.getElementById("filter").addEventListener("input", applyFilter);

  render();
})();
</script>`;
};

/**
 * GET / — the attention console (docs/04 §Main page, exact top-down order):
 * header, orientation line, attention cards, running strip, idle-assign cards,
 * collapsed stream, summary rail (right column). The inline script applies
 * /stream deltas per the documented event shapes.
 */
export const consolePage = (snapshot: SnapshotPayload, theme: HubWebTheme, summaries: SummaryLine[]): string => {
  const { running, idle } = sessionsByPhase(snapshot.sessions);
  const attentionCounts: Record<string, number> = {};
  for (const item of snapshot.attention) attentionCounts[item.sessionId] = (attentionCounts[item.sessionId] ?? 0) + 1;
  const hueIds = [...snapshot.sessions.map((s) => s.id), ...snapshot.attention.map((a) => a.sessionId)];
  const ago = (iso: string): string => fmtDuration(Date.now() - Date.parse(iso));
  return `<!doctype html><html><head><title>hub console</title>${style(theme, hueVars(hueIds))}</head><body>
<header><h1>hub console</h1><span id="agent-state">${snapshot.agentOn ? "○ agent on" : "○ agent off"}</span>
<nav><a href="/archive">archive</a> <a href="/agent">agent</a></nav>
<input id="filter" placeholder="/ filter" autocomplete="off"></header>
<p id="digest">${esc(snapshot.digest)}</p>
<div class="columns">
<main>
<section id="needs-you"${snapshot.agentOn ? "" : " hidden"}>
<h2>needs you (${snapshot.attention.length})</h2>
<section id="attention-list">${snapshot.attention.length > 0 ? snapshot.attention.map(attentionCard).join("") : `<p class="empty">nothing needs you</p>`}</section>
</section>
<h2>running</h2>
<section id="running-list">${running.length > 0 ? running.map((s) => runningLine(s, attentionCounts[s.id] ?? 0)).join("") : `<p class="empty">nothing running</p>`}</section>
<h2>idle — assign work</h2>
<section id="idle-list">${idle.length > 0 ? idle.map((s) => idleCard(s, ago(s.session.lastActivity))).join("") : `<p class="empty">no idle sessions</p>`}</section>
<button id="stream-chip" aria-expanded="false">▸ stream (0)</button>
<div id="stream-panel" hidden><div id="stream-log" class="stream-log"></div></div>
</main>
<aside id="summary-rail"${snapshot.agentOn ? "" : " hidden"}><h2>summary rail</h2><div id="summary-list">${summaries.length > 0 ? summaries.map(summaryLine).join("") : `<p class="empty">no summaries yet</p>`}</div></aside>
</div>
<p class="keys">keys: a next attention · s stream · / filter</p>
${consoleScript(snapshot)}
</body></html>`;
};

// ---- placeholder pages (tk-nbw) ----

const sessionLine = (s: SessionDigest): string =>
  `<li><a href="/session/${s.id}">${s.id}</a> · ${s.session.phase} · ${s.session.title}</li>`;

const sessionsList = (snapshot: SnapshotPayload): string => {
  if (snapshot.sessions.length === 0) return "<p>no open sessions</p>";
  return `<ul>${snapshot.sessions.map(sessionLine).join("")}</ul>`;
};

/** GET /session/:id — session detail (placeholder; full log renderer pending). */
export const sessionPage = (id: string, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · ${id}</title>${style(theme, "")}</head><body>` +
  `<h1>session ${id}</h1><p>full session detail renderer pending</p>` +
  `<p><a href="/">← console</a></p></body></html>`;

/** GET /agent — hub-agent surface registry (placeholder; real renderer: tk-nbw). */
export const agentPage = (theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub agent</title>${style(theme, "")}</head><body>` +
  `<h1>hub agent</h1><p>no hub agent running — start with <code>hub agent</code></p>` +
  `<p><a href="/">← console</a></p></body></html>`;

/** GET /archive — index of closed sessions (placeholder; real renderer: tk-nbw). */
export const archivePage = (theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub archive</title>${style(theme, "")}</head><body>` +
  `<h1>archive</h1><p>no archived sessions</p>` +
  `<p><a href="/">← console</a></p></body></html>`;

/** GET /archive/:id — archived session detail (placeholder; real renderer: tk-nbw). */
export const archivedSessionPage = (id: string, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · ${id}</title>${style(theme, "")}</head><body>` +
  `<h1>archived session ${id}</h1><p>archived detail renderer pending (tk-nbw)</p>` +
  `<p><a href="/archive">← archive</a></p></body></html>`;

/** 404 page for unknown session ids — lists open sessions (docs/04 §Routes). */
export const sessionNotFoundPage = (snapshot: SnapshotPayload, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · not found</title>${style(theme, "")}</head><body>` +
  `<h1>session not found</h1>${sessionsList(snapshot)}` +
  `<p><a href="/">← console</a></p></body></html>`;
