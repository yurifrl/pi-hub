// web/src/html.ts — server-side HTML template strings, one function per page
// (docs/04-web.md §Server: hand-rolled, no framework, no client bundle).
// The console page is the real renderer (tk-swx); the other pages remain
// placeholders for tk-nbw. Pure string building; no I/O.

import type { AttentionItem, Phase, SummaryLine } from "@yurifrl/hub";
import { hueVars } from "./hue";
import { sessionsByPhase } from "./snapshot";
import type {
  AgentPageInfo,
  HubArchiveEntry,
  HubWebTheme,
  LogViewEntry,
  SessionDetail,
  SessionDigest,
  SnapshotPayload,
  SurfaceState,
} from "./types";

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

/* session detail + archive (docs/04 §Session detail) */
.detail-head{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
.detail-head h1{font-size:1.1rem;margin:0}
.badge{border:1px solid var(--muted);border-radius:4px;padding:0 6px;font-size:.85em;color:var(--muted)}
.badge.closed{color:var(--err);border-color:var(--err)}
.timeline{display:flex;gap:2px;align-items:center;margin:.4rem 0;flex-wrap:wrap}
.timeline .seg{padding:0 6px;border-radius:3px;font-size:.85em}
.timeline .seg-working{background:rgba(63,214,143,.18);color:var(--ok)}
.timeline .seg-waiting{background:rgba(245,192,78,.18);color:var(--warn)}
.timeline .seg-blocked{background:rgba(255,122,154,.18);color:var(--err)}
.timeline .seg-idle{background:rgba(139,151,176,.18);color:var(--muted)}
.timeline .seg-at{color:var(--muted);font-size:.8em}
.detail-log{max-height:26rem;overflow-y:auto;background:rgba(0,0,0,.5);border:1px solid var(--muted);border-radius:6px;padding:.5rem}
.dlog{display:flex;gap:.5rem;padding:.1rem 0}
.dlog .lt{color:var(--muted);white-space:nowrap}
.dlog .lk{color:var(--accent);white-space:nowrap}
.dlog.kind-system .lk{color:var(--muted)}
.dlog.kind-prompt .lk{color:var(--ok)}
.dlog.kind-think .lk{color:var(--muted)}
.dlog.kind-tool .lk{color:var(--warn)}
.dlog.kind-result .lk{color:var(--muted)}
.dlog.kind-result.err .lk{color:var(--err)}
.dlog .lx{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.tool-bar{display:flex;gap:.5rem;align-items:center;padding:.15rem 0;font-size:.9em}
.tool-bar .ok-dot{color:var(--ok)}.tool-bar .err-dot{color:var(--err)}.tool-bar .run-dot{color:var(--muted)}
.tool-group{border:1px solid var(--muted);border-radius:6px;padding:.3rem .6rem;margin:.3rem 0}
.tool-group>header{display:flex;gap:.5rem;align-items:center;cursor:pointer}
.tool-group .count{color:var(--muted)}
.tool-group .results{margin:.2rem 0 .2rem .8rem}
.pinned{position:sticky;bottom:0;background:rgba(0,0,0,.85);border-top:1px solid var(--muted);padding:.5rem 0;margin-top:.5rem}
.pinned form{display:flex;gap:.5rem}
.pinned input{flex:1;background:rgba(0,0,0,.5);color:inherit;border:1px solid var(--accent);border-radius:4px;padding:.3rem .6rem}
.pinned .state{color:var(--muted);align-self:center}
.readonly-note{color:var(--muted);border:1px dashed var(--muted);border-radius:6px;padding:.5rem .75rem;margin-top:.5rem}
.final-summary{border-left:3px solid var(--accent);padding:.3rem .75rem;margin:.4rem 0}
.res-list{margin:.2rem 0;padding-left:1.2rem}

/* archive index + agent page (docs/04 §Routes, §Agent page) */
.arch-row{display:flex;gap:.6rem;align-items:baseline;padding:.2rem 0}
.arch-row .when{color:var(--muted);white-space:nowrap}
.arch-row a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.month-h{margin:.8rem 0 .2rem;color:var(--accent)}
.surface-card{border:1px solid var(--muted);border-left:3px solid var(--accent);border-radius:6px;padding:.5rem .75rem;margin:.5rem 0;background:rgba(0,0,0,.35)}
.surface-card .headline{margin:.2rem 0;font-weight:bold}
.surface-card .stale{color:var(--warn)}
.surface-sec{margin:.5rem 0}
.surface-sec h3{margin:0 0 .2rem;font-size:.95em}
.surface-sec.tone-warn h3{color:var(--warn)}
.surface-sec.tone-err h3{color:var(--err)}
.surface-sec pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}
.attn-counts{display:flex;gap:.8rem;margin:.4rem 0}
.attn-counts .c-approval{color:var(--warn)}.attn-counts .c-question{color:var(--accent)}
.attn-counts .c-blocked{color:var(--err)}.attn-counts .c-idle{color:var(--muted)}
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

// ---- shared 404 helper + archive index + agent page ----

const sessionLine = (s: SessionDigest): string =>
  `<li><a href="/session/${s.id}">${s.id}</a> · ${s.session.phase} · ${s.session.title}</li>`;

const sessionsList = (snapshot: SnapshotPayload): string => {
  if (snapshot.sessions.length === 0) return "<p>no open sessions</p>";
  return `<ul>${snapshot.sessions.map(sessionLine).join("")}</ul>`;
};

// ---- session detail (GET /session/:id + archived flavor, docs/04 §Session detail) ----

/** Log-view kind → glyph (docs/04 detail wireframe: ▶ session_start, ▸ prompt, ● message, ⚙ tool, ⋯ think, ■ close). */
const LOG_GLYPH: Record<string, string> = {
  system: "▶",
  prompt: "▸",
  message: "●",
  tool: "⚙",
  result: "··",
  think: "⋯",
};

const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const logLine = (e: LogViewEntry): string => {
  const meta = e.meta as { ok?: unknown } | undefined;
  const errCls = e.kind === "result" && meta?.ok === false ? " err" : "";
  return `<div class="dlog kind-${esc(e.kind)}${errCls}"><span class="lt">${clockTime(e.t)}</span>` +
    `<span class="lk">${LOG_GLYPH[e.kind] ?? "·"} ${esc(e.kind)}</span><span class="lx">${esc(e.text)}</span></div>`;
};

/** One timeline segment: phase word tinted per phase + transition time. */
const timelineSeg = (p: Phase, at: string): string =>
  `<span class="seg seg-${p}">${p}</span><span class="seg-at">${esc(at.slice(11, 16))}</span>`;

/**
 * Phase timeline (docs/04 §Session detail): rail from the record's bounded
 * `phaseHistory` (newest right); absent field → current phase only.
 */
const phaseTimeline = (record: SessionDetail["record"]): string => {
  const history = record.phaseHistory ?? [{ phase: record.phase, at: record.startedAt }];
  return `<div class="timeline">${history.map((h) => timelineSeg(h.phase, h.at)).join("<span class=seg-at>→</span>")}</div>`;
};

/** Tool meta extraction — meta is free-form per-kind extras (docs/02 ## logs). */
type ToolMeta = { tool?: unknown; ok?: unknown; durationMs?: unknown };
const toolMeta = (e: LogViewEntry): ToolMeta => (e.meta ?? {}) as ToolMeta;

/**
 * Tool bars grouped by tool name (docs/04 §Session detail: one compact row
 * per `tool` log entry — tool name, arg digest, duration, ok/err dot;
 * collapsed by default per tool kind, click expands the results).
 */
const toolBars = (entries: LogViewEntry[]): string => {
  const calls = entries.filter((e) => e.kind === "tool");
  if (calls.length === 0) return "";
  const results = entries.filter((e) => e.kind === "result");
  const byTool = new Map<string, LogViewEntry[]>();
  for (const c of calls) {
    const name = String(toolMeta(c).tool ?? "?");
    const list = byTool.get(name) ?? [];
    list.push(c);
    byTool.set(name, list);
  }
  // pair each call with the next result of the same tool after it (ok/duration)
  const okOf = (c: LogViewEntry): boolean | undefined => {
    const idx = calls.indexOf(c);
    const r = results.find((r) => toolMeta(r).tool === toolMeta(c).tool && results.indexOf(r) >= idx);
    return r === undefined ? undefined : toolMeta(r).ok !== false;
  };
  const durOf = (c: LogViewEntry): string => {
    const idx = calls.indexOf(c);
    const r = results.find((r) => toolMeta(r).tool === toolMeta(c).tool && results.indexOf(r) >= idx);
    const ms = r === undefined ? undefined : toolMeta(r).durationMs;
    return typeof ms === "number" ? fmtDuration(ms) : "";
  };
  const groups = [...byTool.entries()].map(([name, list]) => {
    const oks = list.filter((c) => okOf(c) === true).length;
    const errs = list.filter((c) => okOf(c) === false).length;
    const summary = `${list.length}${errs > 0 ? ` (${oks} ok · ${errs} err)` : ""}`;
    const rows = list
      .map(
        (c) =>
          `<div class="tool-bar"><span class="${okOf(c) === false ? "err-dot" : okOf(c) === undefined ? "run-dot" : "ok-dot"}">●</span>` +
          `<span>${esc(String(toolMeta(c).tool ?? name))}</span><span class="count">${esc(c.text)}</span>` +
          `<span class="count">${durOf(c)}</span></div>`,
      )
      .join("");
    return `<details class="tool-group"><header><strong>${esc(name)}</strong> <span class="count">${esc(summary)}</span></header><div class="results">${rows}</div></details>`;
  });
  return `<section><h2>tool bars</h2>${groups.join("")}</section>`;
};

/** Detail-page client script: /stream deltas for THIS session only + ?since= log tailing + send box (docs/04 §Client state). */
const detailScript = (id: string, lastT: number): string =>
  `<script>
(() => {
  const id = ${JSON.stringify(id)};
  let lastT = ${lastT};
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const GLYPH = { system: "\\u25b6", prompt: "\\u25b8", message: "\\u25cf", tool: "\\u2699", result: "\\u00b7\\u00b7", think: "\\u22ef" };
  const line = (e) =>
    '<div class="dlog kind-' + esc(e.kind) + (e.kind === "result" && e.meta && e.meta.ok === false ? " err" : "") + '">' +
    '<span class="lt">' + clock(e.t) + '</span><span class="lk">' + (GLYPH[e.kind] || "\\u00b7") + " " + esc(e.kind) + '</span><span class="lx">' + esc(e.text) + "</span></div>";
  const log = document.getElementById("detail-log");
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // live tail: fetch only entries newer than the last rendered line (?since=)
  const tail = async () => {
    const res = await fetch("/session/" + encodeURIComponent(id) + "?since=" + lastT);
    if (!res.ok) return;
    const d = JSON.parse(await res.text());
    for (const e of d.entries) { log.insertAdjacentHTML("beforeend", line(e)); if (e.t > lastT) lastT = e.t; }
    log.scrollTop = log.scrollHeight;
  };
  const phaseWord = document.getElementById("phase-now");
  if ("EventSource" in window) {
    const es = new EventSource("/stream");
    es.addEventListener("snapshot", () => tail()); // authoritative; refresh the tail
    es.addEventListener("log", (e) => { const d = JSON.parse(e.data); if (d.sessionId === id) { lastT = Math.max(lastT, d.entry.t); log.insertAdjacentHTML("beforeend", line(d.entry)); log.scrollTop = log.scrollHeight; } });
    es.addEventListener("phase", (e) => { const d = JSON.parse(e.data); if (d.sessionId === id && phaseWord) { phaseWord.textContent = d.phase; phaseWord.className = "phase phase-" + d.phase; } });
    es.addEventListener("summary", (e) => { const d = JSON.parse(e.data); if (d.sessionId === id) tail(); });
  }
  setInterval(tail, 5000); // poll safety net alongside the stream
  const form = document.getElementById("send-form");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    const state = document.getElementById("send-state");
    state.textContent = "queued\\u2026";
    post("/api/send", { sessionId: id, text: text }).then(async (r) => {
      state.textContent = r.ok ? "delivered" : (await r.json()).error;
      if (r.ok) input.value = "";
    });
  });
})();
</script>`;

/**
 * GET /session/:id — open flavor: head (hue bar, id, phase, started, model),
 * phase timeline, full log (via the LINK, bounded tail), tool bars, pinned
 * send box (docs/04 §Session detail + wireframe).
 */
export const sessionPage = (d: SessionDetail & { flavor: "open" }, theme: HubWebTheme): string => {
  const lastT = d.entries.at(-1)?.t ?? 0;
  return `<!doctype html><html><head><title>hub · ${esc(d.id)}</title>${style(theme, hueVars([d.id]))}</head><body>
<header class="detail-head">${hueBar(d.id)}<h1>${esc(d.id)}</h1>
<span class="phase phase-${d.record.phase}" id="phase-now">${d.record.phase}</span>
<span class="hint">started ${esc(d.record.startedAt.slice(0, 16).replace("T", " "))} · ${esc(d.record.model)}</span>
<nav><a href="/">← console</a> <a href="/archive">archive</a> <a href="/agent">agent</a></nav></header>
${phaseTimeline(d.record)}
<h2>log <span class="hint">(${esc(d.record.log)} — linked, not embedded)</span></h2>
<div id="detail-log" class="detail-log">${d.entries.map(logLine).join("")}</div>
${toolBars(d.entries)}
<div class="pinned"><form id="send-form" class="inline-form"><input name="text" placeholder="send to ${esc(d.id)}" autocomplete="off">` +
    `<span class="hint">⏎ sends</span><span class="state" id="send-state"></span></form></div>
${detailScript(d.id, lastT)}
</body></html>`;
};

/** Resolution list for the archived flavor (docs/02 §archive: resolutions tail). */
const resolutionList = (items: AttentionItem[]): string => {
  if (items.length === 0) return "";
  return `<ul class="res-list">${items
    .map((i) => `<li><span class="sid">${esc(i.id)}</span> ${esc(i.kind)} — ${esc(i.text)}${i.answer !== undefined ? ` → ${esc(i.answer)}` : ""}</li>`)
    .join("")}</ul>`;
};

/**
 * Archived flavor (docs/04 §Session detail + wireframe): closed badge,
 * closedAt + closedBy, final summary pinned above the log; send box replaced
 * by a read-only note; no live script — archived sessions are immutable.
 */
export const archivedSessionPage = (d: SessionDetail & { flavor: "archived" }, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · ${esc(d.id)}</title>${style(theme, hueVars([d.id]))}</head><body>
<header class="detail-head">${hueBar(d.id)}<h1>${esc(d.id)}</h1><span class="badge closed">ARCHIVED</span>
<span class="hint">closed ${esc(d.closedAt.slice(0, 16).replace("T", " "))} by ${esc(d.closedBy)}</span>
<nav><a href="/archive">← archive</a> <a href="/">console</a></nav></header>
<div class="final-summary"><strong>final summary</strong><br>${esc(d.finalSummary)}${resolutionList(d.resolutions)}</div>
<h2>log <span class="hint">(${esc(d.record.log)} — read-only)</span></h2>
<div class="detail-log">${d.entries.map(logLine).join("") || '<p class="empty">log file not retained</p>'}</div>
<p class="readonly-note">closed — read-only</p>
</body></html>`;

/** 404 page for unknown session ids — lists open sessions (docs/04 §Routes). */
export const sessionNotFoundPage = (snapshot: SnapshotPayload, theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub · not found</title>${style(theme, "")}</head><body>` +
  `<h1>session not found</h1>${sessionsList(snapshot)}` +
  `<p><a href="/">← console</a></p></body></html>`;

// ---- archive index (GET /archive, docs/04 §Routes) ----

/** Month-grouped archive rows, newest first (the injected archive port owns the order). */
const archiveGrouped = (entries: HubArchiveEntry[]): string => {
  if (entries.length === 0) return '<p class="empty">no archived sessions</p>';
  const byMonth = new Map<string, HubArchiveEntry[]>();
  for (const e of entries) {
    const month = e.path.replace(/^archive\//, "").replace(/\/[^"]+$/, "");
    const list = byMonth.get(month) ?? [];
    list.push(e);
    byMonth.set(month, list);
  }
  return [...byMonth.entries()]
    .map(
      ([month, list]) =>
        `<h3 class="month-h">${esc(month)}</h3>` +
        list
          .map(
            (e) =>
              `<div class="arch-row"><span class="when">${esc(e.closedAt.slice(0, 16).replace("T", " "))}</span>` +
              `<span class="badge">${esc(e.closedBy)}</span><a href="/archive/${encodeURIComponent(e.id)}">${esc(e.id)}</a>` +
              `<span class="hint">${esc(e.finalSummary.slice(0, 80))}</span></div>`,
          )
          .join(""),
    )
    .join("");
};

/** GET /archive — index of closed sessions, grouped by month, link to each detail. */
export const archivePage = (entries: HubArchiveEntry[], theme: HubWebTheme): string =>
  `<!doctype html><html><head><title>hub archive</title>${style(theme, "")}</head><body>
<header><h1>archive</h1><nav><a href="/">← console</a> <a href="/agent">agent</a></nav></header>
<p class="hint">closed sessions from archive/YYYY-MM/*.json — newest first</p>
${archiveGrouped(entries)}
</body></html>`;

// ---- agent page (GET /agent, docs/04 §Agent page + docs/06 §agentSurface) ----

const surfaceStale = (s: SurfaceState): boolean => Date.now() - Date.parse(s.updatedAt) > 5 * 60_000;

/** A file-backed surface: headline + sections (docs/06 SurfaceState shape). */
const surfaceCard = (s: SurfaceState): string => {
  const stale = surfaceStale(s);
  return `<div class="surface-card"><header><strong>${esc(s.agent)}</strong> · surface: ${esc(s.surface)} · rev ${s.revision}` +
    `${stale ? ' <span class="stale">stale</span>' : ""}<span class="hint"> ${esc(s.updatedAt)}</span></header>` +
    `${s.headline !== undefined ? `<p class="headline">${esc(s.headline)}</p>` : ""}` +
    (s.sections ?? [])
      .map(
        (sec) =>
          `<div class="surface-sec${sec.tone !== undefined && sec.tone !== "info" ? ` tone-${sec.tone}` : ""}"><h3>${esc(sec.title)}</h3><pre>${esc(sec.lines.join("\n"))}</pre></div>`,
      )
      .join("") +
    `</div>`;
};

/**
 * Surface registry (docs/04 §Agent page): agentSurface id → renderer over
 * AgentPageInfo + file-backed state. `watcher` is the one synthesized
 * surface (docs/06: built from status.json, no file); custom ids render the
 * file state; unknown ids degrade to the generic card — never a 404.
 */
const SURFACE_RENDERERS: Record<string, (info: AgentPageInfo, file: SurfaceState | null) => string> = {
  watcher: (info) => {
    const c = info.counts;
    return `<div class="surface-card"><p class="headline">${esc(info.digest)}</p>` +
      `<div class="attn-counts">` +
      `<span class="c-approval">⚠ ${c.approval}</span><span class="c-question">⏳ ${c.question}</span>` +
      `<span class="c-blocked">⛔ ${c.blocked}</span><span class="c-idle">💤 ${c.idle}</span></div>` +
      `<p>${info.lastSummary !== null ? esc(info.lastSummary.text) : '<span class="hint">no summaries yet</span>'}</p>` +
      `<p class="hint">phase ${esc(info.record.phase)} · last activity ${esc(info.record.lastActivity.slice(0, 16).replace("T", " "))} · cadence heartbeat every cycle</p>` +
      `<p><a href="/session/${encodeURIComponent(info.sessionId)}">→ open session</a></p></div>`;
  },
  pending: (_info, file) => (file !== null ? surfaceCard(file) : GENERIC_NOTE),
};

/** Fallback body for unknown ids / missing files (docs/06 rule 4). */
const GENERIC_NOTE = `<div class="surface-card"><p class="hint">file-backed surface unavailable — generic card below</p></div>`;

/** Generic card: agent name, kind, digest, link to session detail (docs/04 §Agent page). */
const genericCard = (info: AgentPageInfo): string =>
  `<div class="surface-card"><header><strong>${esc(info.record.title)}</strong> · ${esc(info.record.kind)} · surface: unknown id</header>` +
  `<p>▍ digest: ${esc(info.digest)}</p>` +
  `<p><a href="/session/${encodeURIComponent(info.sessionId)}">→ open session</a></p></div>`;

/**
 * GET /agent — the hub agent's declared custom surface. No live agent →
 * empty-state page (docs/04 §Routes). Unknown agentSurface id → generic
 * card; the registry degrades, it does not fail.
 */
export const agentPage = (
  info: AgentPageInfo | null,
  file: SurfaceState | null,
  theme: HubWebTheme,
): string => {
  const body =
    info === null
      ? `<p class="empty">no hub agent running — start with <code>hub agent</code></p>`
      : (() => {
          const id = info.record.agentSurface ?? "watcher";
          const renderer = SURFACE_RENDERERS[id];
          if (renderer === undefined) return genericCard(info);
          return renderer(info, file);
        })();
  return `<!doctype html><html><head><title>hub agent</title>${style(theme, "")}</head><body>
<header><h1>hub agent</h1>${info !== null ? `<span class="badge">surface: ${esc(info.record.agentSurface ?? "watcher")}</span>` : ""}` +
    `<nav><a href="/">← console</a> <a href="/archive">archive</a></nav></header>
${body}
</body></html>`;
};
