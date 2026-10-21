// cli/src/render/watch_view.ts — `hub watch` painter (docs/03-cli.md §hub
// watch): WatchState + terminal size in → cell grid out. Layout: header row,
// then the sessions rail (symbol + name + unread count) | the selected
// session's chat, then a compose row and a key/notice footer. Pure — no ANSI;
// screen.ts owns the escape encoding.

import type { LogEntry } from "@yurifrl/hub";
import {
  openAttention,
  railIds,
  sessionGlyph,
  sessionName,
  type ViewMetrics,
  type WatchState,
} from "../screens/watch";
import type { Cell, ThemeTokenOrHue } from "./screen";
import { clockOf, wrapText } from "./stream";
import { hueIndex } from "./theme";

type Seg = [text: string, fg?: ThemeTokenOrHue, bold?: boolean];

const cellsOf = (segs: Seg[]): Cell[] => {
  const out: Cell[] = [];
  for (const [text, fg, bold] of segs) {
    for (const ch of Array.from(text)) out.push({ ch, ...(fg !== undefined ? { fg } : {}), ...(bold === true ? { bold: true } : {}) });
  }
  return out;
};

const fit = (cells: Cell[], width: number): Cell[] =>
  cells.length >= width ? cells.slice(0, width) : [...cells, ...Array.from({ length: width - cells.length }, () => ({ ch: " " }))];

/** One-line text: control characters flattened, long text ellipsized to `width` code points. */
const clip = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, " ");
  const chars = Array.from(flat);
  return chars.length <= width ? flat : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
};

/** Rail column width: a quarter of the terminal, bounded so names stay legible. */
export const railWidth = (cols: number): number => Math.min(28, Math.max(14, Math.floor(cols / 4)));

const wrapLines = (text: string, width: number): string[] =>
  text.split("\n").flatMap((line) => wrapText(line.replace(/\t/g, "  "), width));

/** Argument keys that best describe a tool call, most telling first. */
const ARG_KEYS = ["command", "path", "file", "pattern", "query", "task", "i"];

/** `bash {"command":"ls"}` → `bash ls`; unparseable argument text is shown as is. */
export const toolSummary = (text: string): string => {
  const at = text.indexOf(" ");
  if (at < 0) return text;
  const name = text.slice(0, at);
  const raw = text.slice(at + 1).trim();
  if (raw === "" || raw === "{}") return name;
  try {
    const args: unknown = JSON.parse(raw);
    if (typeof args === "object" && args !== null) {
      const rec = args as Record<string, unknown>;
      const key = ARG_KEYS.find((k) => typeof rec[k] === "string") ?? Object.keys(rec).find((k) => typeof rec[k] === "string");
      if (key !== undefined) return `${name} ${String(rec[key])}`;
    }
  } catch {
    // truncated/odd payload: fall through to the raw text
  }
  return text;
};

/**
 * Conversation → display lines. Messages get a `time who` header and an
 * indented body; tool calls are one muted, ellipsized line each and empty
 * system rows are dropped, so a busy agent does not drown the dialogue.
 */
export const chatLines = (entries: LogEntry[], who: string, hue: number, width: number): Cell[][] => {
  const out: Cell[][] = [];
  const body = Math.max(1, width - 2);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    if (e.kind === "user_message" || e.kind === "assistant_message") {
      if (prev !== undefined && out.length > 0) out.push([]);
      const you = e.kind === "user_message";
      out.push(cellsOf([[clockOf(e.t), "muted"], [" "], [you ? "you" : who, you ? "accent" : hue, true]]));
      for (const l of wrapLines(e.text, body)) out.push(cellsOf([["  "], [l]]));
      return;
    }
    const tool = e.kind === "tool_call";
    const shown = tool ? toolSummary(e.text) : e.text;
    if (shown.trim() === "") return;
    out.push(cellsOf([[tool ? "  ▶ " : "  · ", "muted"], [clip(shown, Math.max(1, width - 4)), "muted"]]));
  });
  return out;
};

export type WatchView = { rows: Cell[][]; view: ViewMetrics };

/** Compose one frame of `cols`×`rows` cells. */
export const paintWatchView = (s: WatchState, cols: number, rows: number, now: number): WatchView => {
  const ids = railIds(s.status);
  const sessions = s.status?.sessions ?? {};
  const needYou = (s.status?.attention ?? []).filter((a) => a.resolvedAt === undefined).length;
  const rw = railWidth(cols);
  const cw = Math.max(1, cols - rw - 1); // chat column, after the `│` divider
  const bodyRows = Math.max(1, rows - 4); // header + title + compose + footer around the body

  // ---- header ----
  const header: Seg[] = [
    [" hub watch", "accent", true],
    [` · ${ids.length} session${ids.length === 1 ? "" : "s"}`, "muted"],
    needYou > 0 ? [` · ${needYou} need you`, "warn", true] : [""],
    s.offline ? [" · hub offline — read-only", "err"] : [""],
  ];

  // ---- rail ----
  const rail: Cell[][] = ids.length === 0 ? [cellsOf([[" (no sessions)", "muted"]])] : [];
  ids.forEach((id, i) => {
    const rec = sessions[id];
    const sel = id === s.selected;
    const { glyph, token } = sessionGlyph(rec, openAttention(s, id).length > 0);
    const unread = s.unread[id] ?? 0;
    const badge = unread > 0 ? ` +${unread > 99 ? "99" : unread}` : "";
    const nameW = Math.max(1, rw - 4 - Array.from(badge).length);
    const name = clip(sessionName(id, rec), nameW);
    const pad = " ".repeat(Math.max(0, nameW - Array.from(name).length));
    void i;
    rail.push(cellsOf([[sel ? "▸" : " ", "accent", true], [glyph, token, true], [" "], [name + pad, hueIndex(id), sel], [badge, "accent", true]]));
  });

  // ---- chat ----
  const rec = s.selected === null ? undefined : sessions[s.selected];
  const title: Seg[] =
    s.selected === null || rec === undefined
      ? [[" waiting for sessions…", "muted"]]
      : [
          [` ${sessionName(s.selected, rec)}`, hueIndex(s.selected), true],
          [` · ${rec.phase}`, sessionGlyph(rec, false).token],
          ...[rec.model, clip(rec.title, 40)].filter((t) => t.trim() !== "").map((t): Seg => [` · ${t}`, "muted"]),
        ];
  const all = s.selected === null ? [] : chatLines(s.entries[s.selected] ?? [], sessionName(s.selected, rec), hueIndex(s.selected), cw);
  const asks = s.selected === null ? [] : openAttention(s, s.selected);

  const askRows = asks.length > 0 ? 1 : 0;
  const chatRows = Math.max(1, bodyRows - askRows);
  const maxScroll = Math.max(0, all.length - chatRows);
  const scroll = Math.min(s.scroll, maxScroll);
  const end = all.length - scroll;
  const shown = all.slice(Math.max(0, end - chatRows), end);
  const chat: Cell[][] =
    all.length === 0 && s.selected !== null
      ? [cellsOf([["  no messages yet", "muted"]])]
      : [...Array.from({ length: chatRows - shown.length }, () => [] as Cell[]), ...shown];
  if (scroll > 0 && chat.length > 0) chat[chat.length - 1] = cellsOf([[` ↓ ${scroll} line${scroll === 1 ? "" : "s"} below · PgDn`, "muted"]]);

  const chatCol: Cell[][] = [...chat];
  while (chatCol.length < chatRows) chatCol.push([]);
  if (asks[0] !== undefined) chatCol.push(cellsOf([[" ⚠ ", "warn", true], [clip(asks[0].text, cw - 12), "warn"], [" · ⏎ answers", "muted"]]));

  // ---- compose + footer ----
  const draft = s.selected === null ? "" : (s.drafts[s.selected] ?? "");
  const compose: Seg[] =
    s.focus === "compose"
      ? [[" › ", "accent", true], [draft], ["█", "accent"]]
      : draft.length > 0
        ? [[" › ", "muted"], [draft, "muted"]]
        : [[" › ⏎ to write a message", "muted"]];
  const hint =
    s.focus === "compose"
      ? asks.length > 0
        ? "⏎ answer · esc rail · PgUp/PgDn scroll"
        : "⏎ send · esc rail · PgUp/PgDn scroll"
      : "↑↓ select · 1-9 jump · ⏎ write · PgUp/PgDn scroll · d dismiss · q quit";
  const footer: Seg[] = s.notice !== null ? [[` ${s.notice.text}`, s.notice.tone]] : [[` ${hint}`, "muted"]];

  // ---- assemble ----
  const grid: Cell[][] = [fit(cellsOf(header), cols), fit([...fit(cellsOf([[" sessions", "muted"]]), rw), { ch: "│", fg: "muted" }, ...cellsOf(title)], cols)];
  for (let r = 0; r < bodyRows; r++) {
    const left = fit(rail[r] ?? [], rw);
    const right = chatCol[r] ?? [];
    grid.push(fit([...left, { ch: "│", fg: "muted" }, ...right], cols));
  }
  grid.push(fit(cellsOf(compose), cols));
  grid.push(fit(cellsOf(footer), cols));
  void now;
  return { rows: grid.slice(0, rows), view: { pageRows: Math.max(1, chatRows - 1), maxScroll } };
};

/** Plain-text frame for the piped/static path: one line per session, then the selected chat. */
export const plainSnapshot = (s: WatchState, width: number): string[] => {
  const { rows } = paintWatchView(s, width, 40, Date.now());
  return rows.map((r) => r.map((c) => c.ch).join("").trimEnd());
};
