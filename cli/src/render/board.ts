// cli/src/render/board.ts — board / watch attention-rail layout painter
// (docs/03-cli.md §hub, §Screen buffer → board.ts). Pure function: status
// snapshot + focus in → cells out. Zone stack, focus model, calm-variant
// collapse. No ANSI here — cells carry theme tokens / hue indexes; screen.ts
// owns the escape encoding.

import type { AttentionItem, SessionRecord, StatusSnapshot, ThemeToken } from "@yurifrl/hub";
import { type Cell, type ThemeTokenOrHue } from "./screen";

/** Ordered interactive slots — the focus model (docs/03 §Keys). */
export type FocusSlot =
  | { type: "attention"; index: number }
  | { type: "idle-assign"; sessionId: string };

export type BoardFocus = {
  slot: FocusSlot | null;
  /** committed per-slot answer/assign drafts (per-session history per spec) */
  drafts: Map<string, string>;
  /** open input on the focused slot — typing appends */
  input: string | null;
  /** cursor position inside the open input; absent → end of body (docs/03 §Keys ←/→) */
  cursor?: number;
};

/** Paint-time view of the snapshot the board renders (docs/03 §Layout). */
export type BoardModel = {
  snapshot: StatusSnapshot;
  focus: BoardFocus;
  /** hub agent orientation sentence; absent → mechanical counts only */
  orientation?: string;
  /** width used to lay out zone rules; 0 = unbounded */
  width: number;
  /** display names by session id (list reply extras); absent → first 8 id chars */
  names?: Record<string, string>;
  /** false hides inline inputs (piped stdin) — piped footer, no cursor lines */
  inputsEnabled?: boolean;
};

/** Sessions in phase `working` — the ⏳ RUNNING zone. */
export const runningSessions = (snapshot: StatusSnapshot): [string, SessionRecord][] =>
  Object.entries(snapshot.sessions).filter(([, s]) => s.phase === "working" || s.phase === "waiting");

/** Sessions in phase `idle` — the 💤 IDLE zone. */
export const idleSessions = (snapshot: StatusSnapshot): [string, SessionRecord][] =>
  Object.entries(snapshot.sessions).filter(([, s]) => s.phase === "idle");

/** Calm variant: no attention items and no idle sessions (docs/03 §Calm). */
export const isCalm = (snapshot: StatusSnapshot): boolean =>
  snapshot.attention.length === 0 && idleSessions(snapshot).length === 0;

/** kind → badge token (docs/03 §Layout zone 2). */
export const attentionToken = (kind: AttentionItem["kind"]): ThemeToken =>
  kind === "approval" ? "warn" : kind === "question" ? "accent" : kind === "blocked" ? "err" : "muted";
/** phase → digest-line token (docs/03 §Layout zone 3). */
export const phaseToken = (phase: SessionRecord["phase"]): ThemeToken => (phase === "waiting" ? "warn" : "ok");

/** Age string from an epoch-ms timestamp — `<n>s|m|h|d`. */
export const ageOf = (iso: string, now: number): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const focusableSlots = (snapshot: StatusSnapshot): FocusSlot[] => [
  ...snapshot.attention.map((_, i): FocusSlot => ({ type: "attention", index: i })),
  ...idleSessions(snapshot).map(([id]): FocusSlot => ({ type: "idle-assign", sessionId: id })),
];

/** Move focus up/down across interactive slots, wrapping (docs/03 §Keys ↑↓). */
export const moveFocus = (snapshot: StatusSnapshot, current: FocusSlot | null, delta: 1 | -1): FocusSlot | null => {
  const slots = focusableSlots(snapshot);
  if (slots.length === 0) return null;
  const idx = current === null ? -1 : slots.findIndex((s) => focusEq(s, current));
  const next = (idx + delta + slots.length) % slots.length;
  return slots[next]!;
};

const focusEq = (a: FocusSlot, b: FocusSlot): boolean =>
  a.type === b.type &&
  (a.type === "attention" && b.type === "attention"
    ? a.index === b.index
    : a.type === "idle-assign" && b.type === "idle-assign"
      ? a.sessionId === b.sessionId
      : false);

/** Cells for one text run with a foreground style. */
const run = (text: string, fg?: ThemeTokenOrHue): Cell[] => text.split("").map((ch) => ({ ch, ...(fg !== undefined ? { fg } : {}) }));

/** Hue-bar cell pair: two-cell `▎` in the session's hue (docs/03 §Session hue). */
export const hueBar = (sessionId: string, hueIndex: (id: string) => number): Cell[] => [
  { ch: "▎", fg: hueIndex(sessionId) },
  { ch: "▎", fg: hueIndex(sessionId) },
];

/** The board's line model — testable before cell encoding. */
export type BoardLine = {
  text: string;
  /** ordered segments: (text, style) pairs rendered left to right */
  segs: [string, ThemeTokenOrHue | undefined][];
  /** session hue for the leading two-cell bar; null = no bar */
  hueSessionId?: string;
};

/** Compose the board's lines from the model (pure, no cells). */
export const boardLines = (model: BoardModel, hueIndex: (id: string) => number, now: number): BoardLine[] => {
  const { snapshot, focus } = model;
  const lines: BoardLine[] = [];

  // 1 — orientation line
  const orient =
    model.orientation ?? (snapshot.agent.present ? "agent is on" : undefined);
  const head =
    `hub · ${Object.keys(snapshot.sessions).length} sessions` +
    (snapshot.agent.present ? ` · 1 agent` : "") +
    (orient ? ` · ${orient}` : "");
  lines.push({ text: head, segs: [[head, undefined]] });

  // calm variant collapses ⚠/💤 to one muted (empty) line each
  const calm = isCalm(snapshot);
  // inputs hidden when stdin is piped (docs/03 §TTY degradation)
  const showInput = model.inputsEnabled !== false;

  // 2 — ⚠ NEEDS YOU
  lines.push({ text: "⚠ NEEDS YOU", segs: [["⚠ NEEDS YOU", calm ? "muted" : undefined]] });
  if (calm) {
    lines.push({ text: "  (empty)", segs: [["  (empty)", "muted"]] });
  } else {
    snapshot.attention.forEach((item, i) => {
      const badge = attentionToken(item.kind);
      const name = model.names?.[item.sessionId] ?? item.sessionId.slice(0, 8);
      const row = `▎ ${item.kind.padEnd(9)} ${name.padEnd(8)} ${item.text}`;
      const segs: [string, ThemeTokenOrHue | undefined][] = [
        ["▎", hueIndex(item.sessionId)],
        [row.slice(1), badge],
      ];
      lines.push({ text: row, segs, hueSessionId: item.sessionId });
      // focused item's inline input line: `› <draft><cursor>`
      const focused = focus.slot?.type === "attention" && focus.slot.index === i;
      if (focused && showInput) {
        const draft = focus.drafts.get(item.id) ?? "";
        const body = focus.input ?? draft;
        const cur = focus.cursor ?? body.length;
        const inputRow = `▎ › ${body.slice(0, cur)}█${body.slice(cur)}`;
        lines.push({
          text: inputRow,
          segs: [
            ["▎", hueIndex(item.sessionId)],
            [inputRow.slice(1), "accent"],
          ],
          hueSessionId: item.sessionId,
        });
      }
    });
  }

  // 3 — ⏳ RUNNING
  lines.push({ text: "⏳ RUNNING", segs: [["⏳ RUNNING", undefined]] });
  for (const [id, s] of runningSessions(snapshot)) {
    const desc = s.description ?? s.title;
    // names map present → `● <name> <phase> <description> (<age>)` (docs/03 §Layout zone 3)
    const who = model.names?.[id];
    const row =
      who !== undefined
        ? `▎ ● ${who.padEnd(8)} ${s.phase.padEnd(8)} ${desc} (${ageOf(s.lastActivity, now)})`
        : `▎ ● ${s.phase.padEnd(8)} ${desc} (${ageOf(s.lastActivity, now)})`;
    lines.push({
      text: row,
      segs: [
        ["▎", hueIndex(id)],
        [row.slice(1), phaseToken(s.phase)],
      ],
      hueSessionId: id,
    });
  }

  // 4 — 💤 IDLE
  lines.push({ text: "💤 IDLE", segs: [["💤 IDLE", calm ? "muted" : undefined]] });
  if (calm) {
    lines.push({ text: "  (empty)", segs: [["  (empty)", "muted"]] });
  } else {
    for (const [id, s] of idleSessions(snapshot)) {
      const focused = focus.slot?.type === "idle-assign" && focus.slot.sessionId === id;
      const live = focused && showInput && focus.input !== null;
      const who = model.names?.[id];
      const body = focus.input ?? focus.drafts.get(`idle:${id}`) ?? "";
      const assignPart = live ? `assign: ${body}█` : "assign: _";
      const row =
        who !== undefined
          ? `▎ ○ ${who.padEnd(8)} idle ${ageOf(s.lastActivity, now).padEnd(4)} ${assignPart}`
          : `▎ ○ idle ${ageOf(s.lastActivity, now).padEnd(4)} ${assignPart}`;
      lines.push({
        text: row,
        segs: [
          ["▎", hueIndex(id)],
          [row.slice(1), focused ? "accent" : "muted"],
        ],
        hueSessionId: id,
      });
    }
  }

  // 5 — footer: piped stdin shows the keys-off hint; calm trims to `l log · q quit`
  const footer = model.inputsEnabled === false ? FOOTER_PIPED : calm ? FOOTER_CALM : FOOTER_FULL;
  lines.push({ text: footer, segs: [[footer, "muted"]] });
  return lines;
};

/** Footer hint (full variant; calm trims per docs/03 §Calm). */
export const FOOTER_FULL = "keys ↑↓ move · type to answer · d dismiss · a assign · o open · l log · q quit";
export const FOOTER_CALM = "keys l log · q quit";
/** Footer hint when stdin is piped (docs/03 §TTY degradation). */
export const FOOTER_PIPED = "keys (piped stdin — keys off)";

/**
 * boardLines → cells: the painter proper (docs/03 §Screen buffer → board.ts:
 * "status snapshot + focus in → cells out").
 */
export const paintBoard = (model: BoardModel, hueIndex: (id: string) => number, now: number): Cell[][] => {
  const lines = boardLines(model, hueIndex, now);
  const out: Cell[][] = [];
  for (const line of lines) {
    let cells: Cell[] = [];
    if (line.hueSessionId !== undefined) {
      cells.push(...hueBar(line.hueSessionId, hueIndex));
      for (const [text, style] of line.segs) cells.push(...run(text, style));
    } else {
      for (const [text, style] of line.segs) cells.push(...run(text, style));
    }
    if (model.width > 0) cells = cells.slice(0, model.width);
    out.push(cells);
  }
  return out;
};
