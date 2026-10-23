// cli/src/tui/watch_view.ts - pure model + layout for `hub watch` (sessions rail, chat, compose).
// No IO, no renderer: the reducer maps (state, key) -> (state, effect) and `watchLines` maps
// (state, size) -> styled lines, so both are testable without a TTY.

import type { AttentionRow } from "../ids";
import {
  clipLine,
  lineWidth,
  linesText,
  oneLine,
  padLine,
  sp,
  splitLine,
  textWidth,
  withBg,
  type BgRef,
  type ColorRef,
  type Line,
  type Span,
} from "./colors";
import { editInput, emptyInput, type Key, type TextInput } from "./keys";

export type RailKind = "roster" | "archived" | "log";
export type RailRow = {
  id: string;
  name: string;
  kind: RailKind;
  /** hub phase for roster rows; "" for extras */
  phase: string;
  glyph: string;
  tone: ColorRef;
  /** open attention items for this session */
  open: number;
};

export type ChatKind = "user" | "assistant" | "tool" | "system";
export type ChatRow = { t: string; kind: ChatKind; text: string };
export type ChatItem = { row: ChatRow; n: number };

export const FILTERS = ["all", "user", "assistant", "tool"] as const;
export type Filter = (typeof FILTERS)[number];

export const RAIL_MIN = 14;
export const RAIL_MAX = 60;
export const RAIL_DEFAULT = 24;
const RAIL_STEP = 2;
const MAX_BODY_LINES = 40;

export type Notice = { tone: "ok" | "err" | "warn" | "muted"; text: string };

export type WatchState = {
  rail: RailRow[];
  /** open attention items across the hub */
  attention: AttentionRow[];
  sel: number;
  focus: "rail" | "compose";
  filter: Filter;
  /** closed (archived / log-only) sessions are listed in the rail; persisted across runs */
  showClosed: boolean;
  railW: number;
  /** chat lines scrolled up from the bottom */
  scroll: number;
  draft: TextInput;
  chat: ChatRow[];
  notice: Notice | null;
  offline: boolean;
  /** stdin is not a TTY: the screen renders, keys do nothing */
  keysOff: boolean;
};

export type Effect =
  | { kind: "quit" }
  | { kind: "load" }
  | { kind: "send"; id: string; text: string; answerId?: string }
  | { kind: "dismiss"; id: string; sessionId: string }
  | { kind: "closed"; show: boolean };

export type Step = { state: WatchState; effect?: Effect };
export type Geom = { w: number; h: number };

// ---- rail ------------------------------------------------------------------------

type PhaseGlyph = { glyph: string; tone: ColorRef };

/** Glyph + tone for a roster row (spec: ⚠ needs you, ▶ working, ? waiting, ○ idle, ✖ blocked, · closing). */
export const rosterGlyph = (phase: string, open: number): PhaseGlyph => {
  if (open > 0) return { glyph: "⚠", tone: "warn" };
  switch (phase) {
    case "working":
      return { glyph: "▶", tone: "ok" };
    case "waiting":
      return { glyph: "?", tone: "warn" };
    case "blocked":
      return { glyph: "✖", tone: "err" };
    case "closing":
      return { glyph: "·", tone: "muted" };
    default:
      return { glyph: "○", tone: "muted" };
  }
};

export const extraGlyph = (kind: "archived" | "log"): PhaseGlyph => ({ glyph: kind === "archived" ? "■" : "□", tone: "muted" });

/** Per-row session state: roster rows are `working` or `done` (nothing running); anything else shows its phase. */
export const stateLabel = (r: RailRow): string => {
  if (r.kind !== "roster") return "closed";
  return r.phase === "idle" || r.phase === "" ? "done" : r.phase;
};

export const initialState = (
  rail: RailRow[],
  attention: AttentionRow[],
  opts: { offline?: boolean; keysOff?: boolean; showClosed?: boolean } = {},
): WatchState => {
  const first = rail.findIndex((r) => r.open > 0);
  return {
    rail,
    attention,
    sel: first >= 0 ? first : 0,
    focus: "rail",
    filter: "all",
    showClosed: opts.showClosed === true,
    railW: RAIL_DEFAULT,
    scroll: 0,
    draft: emptyInput,
    chat: [],
    notice: null,
    offline: opts.offline === true,
    keysOff: opts.keysOff === true,
  };
};

export const selectedRow = (s: WatchState): RailRow | undefined => s.rail[s.sel];

/** The first open attention item of the selected session (what a compose send answers). */
export const selectedAttention = (s: WatchState): AttentionRow | undefined => {
  const row = selectedRow(s);
  return row === undefined ? undefined : s.attention.find((a) => a.sessionId === row.id);
};

/** Swap in fresh data, keeping the selection on the same session id when it still exists. */
export const refreshed = (
  s: WatchState,
  data: { rail: RailRow[]; attention: AttentionRow[]; offline: boolean },
): WatchState => {
  const prev = selectedRow(s)?.id;
  const at = prev === undefined ? -1 : data.rail.findIndex((r) => r.id === prev);
  const sel = at >= 0 ? at : Math.max(0, Math.min(s.sel, data.rail.length - 1));
  const moved = data.rail[sel]?.id !== prev;
  return {
    ...s,
    ...data,
    sel,
    ...(moved ? { scroll: 0, draft: emptyInput, focus: "rail" as const, chat: [] } : {}),
  };
};


/** After a send attempt: success clears the draft; failure keeps it so nothing typed is lost. */
export const afterSend = (s: WatchState, ok: boolean, notice: Notice): WatchState => ({
  ...s,
  notice,
  draft: ok ? emptyInput : s.draft,
  scroll: ok ? 0 : s.scroll,
});

// ---- chat items --------------------------------------------------------------------

/** Filter, drop empty rows, collapse adjacent identical rows into `n`. */
export const chatItems = (rows: readonly ChatRow[], filter: Filter): ChatItem[] => {
  const out: ChatItem[] = [];
  for (const row of rows) {
    if (row.text.trim() === "") continue;
    if (filter !== "all" && row.kind !== filter) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.row.kind === row.kind && last.row.text === row.text) last.n += 1;
    else out.push({ row, n: 1 });
  }
  return out;
};

const hardSplit = (word: string, w: number): string[] => {
  const parts: string[] = [];
  let cur = "";
  let cw = 0;
  for (const ch of word) {
    const c = textWidth(ch);
    if (cw + c > w && cur !== "") {
      parts.push(cur);
      cur = "";
      cw = 0;
    }
    cur += ch;
    cw += c;
  }
  if (cur !== "") parts.push(cur);
  return parts;
};

/** Word-wrap `text` to `width` display cells; control characters stripped, blank lines kept. */
export const wrapText = (text: string, width: number): string[] => {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    const clean = para.replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
    if (clean === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    let cur = "";
    for (const word of clean.split(/ +/)) {
      for (const piece of textWidth(word) > w ? hardSplit(word, w) : [word]) {
        if (cur === "") cur = piece;
        else if (textWidth(cur) + 1 + textWidth(piece) <= w) cur += ` ${piece}`;
        else {
          out.push(cur);
          cur = piece;
        }
      }
    }
    if (cur !== "") out.push(cur);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
};

const clock = (iso: string): string => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "        ";
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** The chat as styled lines for a pane `width` cells wide (no scrolling applied). */
export const chatLines = (items: readonly ChatItem[], width: number, who: string): Line[] => {
  const out: Line[] = [];
  for (const { row, n } of items) {
    const count: Line = n > 1 ? [sp(`×${n}`, "muted")] : [];
    if (row.kind === "tool") {
      out.push(splitLine([sp("  ▶ ", "muted"), sp(oneLine(row.text), "muted")], count, width));
      continue;
    }
    if (row.kind === "system") {
      out.push(splitLine([sp("  · ", "muted"), sp(oneLine(row.text), "muted")], count, width));
      continue;
    }
    const user = row.kind === "user";
    out.push(
      splitLine(
        [sp(clock(row.t), "muted"), sp(user ? " › " : " ◆ ", user ? "accent" : "ok"), sp(user ? "you" : who, "fg", { bold: true })],
        count,
        width,
      ),
    );
    const body = wrapText(row.text, width - 2);
    for (const l of body.slice(0, MAX_BODY_LINES)) out.push([sp(`  ${l}`)]);
    if (body.length > MAX_BODY_LINES) out.push([sp(`  … ${body.length - MAX_BODY_LINES} more lines`, "muted")]);
  }
  return out;
};

// ---- geometry -----------------------------------------------------------------------

export type Frame = { W: number; H: number; railW: number; paneW: number; bodyH: number; chatH: number; chatW: number };

export const frameOf = (s: WatchState, geom: Geom): Frame => {
  const W = Math.max(20, geom.w);
  const H = Math.max(8, geom.h);
  const railW = Math.max(8, Math.min(Math.max(RAIL_MIN, Math.min(RAIL_MAX, s.railW)), W - 20));
  const paneW = Math.max(1, W - railW - 1);
  const bodyH = H - 3;
  const chatH = Math.max(1, bodyH - 1 - (selectedAttention(s) !== undefined ? 1 : 0));
  return { W, H, railW, paneW, bodyH, chatH, chatW: Math.max(1, paneW - 1) };
};

const allChatLines = (s: WatchState, f: Frame): Line[] =>
  chatLines(chatItems(s.chat, s.filter), f.chatW, selectedRow(s)?.name ?? "assistant");

const maxScroll = (s: WatchState, geom: Geom): number => {
  const f = frameOf(s, geom);
  return Math.max(0, allChatLines(s, f).length - f.chatH);
};

// ---- reducer ------------------------------------------------------------------------

const clampRail = (n: number): number => Math.max(RAIL_MIN, Math.min(RAIL_MAX, n));

const moveTo = (s: WatchState, idx: number): Step => {
  const sel = Math.max(0, Math.min(idx, s.rail.length - 1));
  if (sel === s.sel) return { state: s };
  return { state: { ...s, sel, scroll: 0, draft: emptyInput, focus: "rail", chat: [] }, effect: { kind: "load" } };
};

/** One key -> next state (+ at most one effect for the caller to perform). */
export const stepWatch = (state: WatchState, key: Key, geom: Geom): Step => {
  if (state.keysOff) return { state };
  const s: WatchState = state.notice === null ? state : { ...state, notice: null };
  if (key.kind === "quit") return { state: s, effect: { kind: "quit" } };
  if (key.kind === "ignore") return { state };
  const page = Math.max(1, frameOf(s, geom).chatH - 1);
  if (key.kind === "pageup") return { state: { ...s, scroll: Math.min(maxScroll(s, geom), s.scroll + page) } };
  if (key.kind === "pagedown") return { state: { ...s, scroll: Math.max(0, s.scroll - page) } };

  if (s.focus === "compose") {
    if (key.kind === "escape") return { state: { ...s, focus: "rail" } };
    if (key.kind === "enter") {
      const text = s.draft.text.trim();
      const row = selectedRow(s);
      if (text === "" || row === undefined) return { state: s };
      const answer = selectedAttention(s);
      return {
        state: s,
        effect: { kind: "send", id: row.id, text, ...(answer !== undefined ? { answerId: answer.id } : {}) },
      };
    }
    const draft = editInput(s.draft, key);
    return { state: draft === s.draft ? s : { ...s, draft } };
  }

  switch (key.kind) {
    case "up":
      return moveTo(s, s.sel - 1);
    case "down":
      return moveTo(s, s.sel + 1);
    case "tab":
      return moveTo(s, s.rail.length === 0 ? 0 : (s.sel + 1) % s.rail.length);
    case "home":
      return moveTo(s, 0);
    case "end":
      return moveTo(s, s.rail.length - 1);
    case "enter": {
      const row = selectedRow(s);
      if (row === undefined) return { state: s };
      if (row.kind !== "roster") return { state: { ...s, notice: { tone: "muted", text: "read-only session — archived or log-only" } } };
      return { state: { ...s, focus: "compose" } };
    }
    case "char": {
      const ch = key.ch;
      if (ch >= "1" && ch <= "9") return moveTo(s, Number(ch) - 1);
      if (ch === "j") return moveTo(s, s.sel + 1);
      if (ch === "k") return moveTo(s, s.sel - 1);
      if (ch === "g") return moveTo(s, 0);
      if (ch === "G") return moveTo(s, s.rail.length - 1);
      if (ch === "q") return { state: s, effect: { kind: "quit" } };
      if (ch === "c") return { state: { ...s, showClosed: !s.showClosed }, effect: { kind: "closed", show: !s.showClosed } };
      if (ch === "f") {
        const next = FILTERS[(FILTERS.indexOf(s.filter) + 1) % FILTERS.length] as Filter;
        return { state: { ...s, filter: next, scroll: 0 } };
      }
      if (ch === "<") return { state: { ...s, railW: clampRail(s.railW - RAIL_STEP) } };
      if (ch === ">") return { state: { ...s, railW: clampRail(s.railW + RAIL_STEP) } };
      if (ch === "d") {
        const row = selectedRow(s);
        const open = selectedAttention(s);
        if (row === undefined || open === undefined) return { state: { ...s, notice: { tone: "muted", text: "nothing to dismiss" } } };
        return { state: s, effect: { kind: "dismiss", id: open.id, sessionId: row.id } };
      }
      return { state: s };
    }
    default:
      return { state: s };
  }
};

// ---- layout --------------------------------------------------------------------------

const caretSpans = (input: TextInput): Span[] => {
  const chars = [...input.text];
  const at = Math.min(input.cursor, chars.length);
  return [sp(chars.slice(0, at).join("")), sp(chars[at] ?? " ", "fg", { bold: true, bg: "band" }), sp(chars.slice(at + 1).join(""))];
};
const headerLine = (s: WatchState, w: number): Line => {
  const n = s.rail.filter((r) => r.open > 0).length;
  const left: Line = [
    sp(" hub watch", "accent", { bold: true }),
    sp(` · ${s.rail.length} sessions${s.showClosed ? "" : " open"} · `, "muted"),
    n > 0 ? sp(`${n} need you`, "warn", { bold: true }) : sp("all calm", "muted"),
  ];
  const right: Line = s.offline ? [sp("(hub offline) ", "muted")] : [];
  return withBg(splitLine(left, right, w, "panel"), "panel");
};

const railWindow = (s: WatchState, slots: number): number => {
  if (s.rail.length <= slots) return 0;
  return Math.max(0, Math.min(s.sel - Math.floor(slots / 2), s.rail.length - slots));
};

const railLines = (s: WatchState, f: Frame): Line[] => {
  const out: Line[] = [withBg(padLine([sp(" sessions", "muted")], f.railW), "panel")];
  const slots = Math.max(0, f.bodyH - 1);
  const first = railWindow(s, slots);
  for (let i = first; i < Math.min(s.rail.length, first + slots); i++) {
    const r = s.rail[i] as RailRow;
    const focused = i === s.sel;
    const bg: BgRef = focused ? "band" : "panel";
    const left: Line = [
      sp("▎", { hue: r.id }),
      sp(focused ? "▸" : " ", "accent"),
      sp(r.glyph, r.tone),
      sp(" "),
      sp(r.name, focused || r.kind === "roster" ? "fg" : "muted", { bold: focused }),
    ];
    const right: Line = [...(r.open > 1 ? [sp(`+${r.open} `, "warn")] : []), sp(`${stateLabel(r)} `, r.tone)];
    out.push(withBg(splitLine(left, right, f.railW), bg));
  }
  while (out.length < f.bodyH) out.push(withBg(padLine([], f.railW), "panel"));
  return out.slice(0, f.bodyH);
};

const paneLines = (s: WatchState, f: Frame): Line[] => {
  const row = selectedRow(s);
  const out: Line[] = [];
  if (row === undefined) {
    out.push(withBg(padLine([sp(" no sessions", "muted")], f.paneW), "panel"));
    while (out.length < f.bodyH) out.push([]);
    out.length = f.bodyH;
    out[1] = [sp("  nothing on this machine yet", "muted")];
    return out;
  }
  const kindNote = row.kind === "roster" ? row.phase || "open" : row.kind === "archived" ? "archived · read-only" : "log only · read-only";
  const strip: Line = [sp(` ${row.name}`, "fg", { bold: true }), sp(` · ${kindNote} · ${row.id.slice(0, 8)}`, "muted")];
  out.push(withBg(splitLine(strip, [sp(`filter:${s.filter} `, "muted")], f.paneW), "panel"));

  const lines = allChatLines(s, f);
  const total = lines.length;
  const scroll = Math.min(s.scroll, Math.max(0, total - f.chatH));
  const end = total - scroll;
  const start = Math.max(0, end - f.chatH);
  const view = lines.slice(start, end);
  if (total === 0) view.push([sp(s.chat.length === 0 ? "  no messages yet" : "  nothing matches this filter", "muted")]);
  const overflow = total > f.chatH;
  const thumbSize = overflow ? Math.max(1, Math.round((f.chatH * f.chatH) / total)) : 0;
  const span = total - f.chatH;
  const thumbAt = overflow ? Math.round((f.chatH - thumbSize) * (span === 0 ? 1 : start / span)) : 0;
  for (let i = 0; i < f.chatH; i++) {
    const body = padLine(clipLine(view[i] ?? [], f.chatW), f.chatW);
    const thumb = overflow && i >= thumbAt && i < thumbAt + thumbSize ? "▐" : " ";
    out.push([...body, sp(thumb, "muted")]);
  }
  const att = selectedAttention(s);
  if (att !== undefined) {
    out.push(withBg(padLine([sp(" ⚠ ", "warn", { bold: true }), sp(oneLine(att.text))], f.paneW), "panel"));
  }
  while (out.length < f.bodyH) out.push([]);
  return out.slice(0, f.bodyH);
};

const composeLine = (s: WatchState, w: number): Line => {
  if (s.keysOff) return padLine([], w);
  const row = selectedRow(s);
  if (s.focus === "compose") return withBg(padLine([sp(" › ", "accent", { bold: true }), ...caretSpans(s.draft)], w), "input");
  const note = row !== undefined && row.kind !== "roster" ? "read-only session" : "⏎ to write a message";
  return withBg(padLine([sp(" › ", "accent", { bold: true }), sp(note, "muted")], w), "input");
};

const footerLine = (s: WatchState, w: number): Line => {
  if (s.keysOff) return padLine([sp(" (piped stdin — keys off)", "muted")], w);
  if (s.notice !== null) return padLine([sp(` ${s.notice.text}`, s.notice.tone)], w);
  if (s.focus === "compose") return padLine([sp(" ⏎ send · esc back · ←/→ move · ⌫ delete · ^c quit", "muted")], w);
  return padLine(
    [sp(` jk/↑↓ select · gG ends · 1-9 jump · ⏎ write · f filter:${s.filter} · c closed:${s.showClosed ? "shown" : "hidden"} · ^u/^d scroll · < > rail · d dismiss · q quit`, "muted")],
    w,
  );
};

/** The whole screen as lines: exactly `max(8, h)` rows. Every row is clipped to the width. */
export const watchLines = (s: WatchState, geom: Geom): Line[] => {
  const f = frameOf(s, geom);
  const rail = railLines(s, f);
  const pane = paneLines(s, f);
  const out: Line[] = [headerLine(s, f.W)];
  for (let i = 0; i < f.bodyH; i++) {
    const merged: Line = [...(rail[i] ?? padLine([], f.railW)), sp(" "), ...padLine(pane[i] ?? [], f.paneW)];
    out.push(clipLine(merged, f.W));
  }
  out.push(composeLine(s, f.W));
  out.push(footerLine(s, f.W));
  return out.map((l) => (lineWidth(l) > f.W ? clipLine(l, f.W) : l));
};

/** Plain text of the screen (tests, static frames). */
export const watchText = (s: WatchState, geom: Geom): string => linesText(watchLines(s, geom));
