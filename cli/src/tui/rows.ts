// cli/src/tui/rows.ts - pure model + layout for the attention board (spec §hub (bare)).
// No IO, no renderer: `boardKey` maps (state, key) -> (state, action) and `boardLines`
// maps (state, size) -> exactly `height` styled lines of exactly `width` cells.

import { openAttentionOf, rosterOf, sessionName, type AttentionRow, type RosterSession } from "../ids";
import { clipText, oneLine, padLine, sp, splitLine, withBg, type ColorRef, type Line } from "./colors";
import { footerLine, footerMode } from "./footer";
import { editInput, emptyInput, type Key, type TextInput } from "./keys";

export type BoardItem = AttentionRow & { name: string; createdAt: number | null };
export type BoardSession = { id: string; name: string; phase: string; description: string; since: number | null };

export type BoardData = {
  orientation: string;
  attention: BoardItem[];
  running: BoardSession[];
  idle: BoardSession[];
};

export type BoardState = {
  focus: number;
  input: TextInput;
  /** true while the input is a task for the focused idle session */
  assigning: boolean;
};

export type BoardAction =
  | { kind: "none" }
  | { kind: "quit" }
  | { kind: "log" }
  | { kind: "open" }
  | { kind: "answer"; id: string; text: string }
  | { kind: "assign"; id: string; text: string }
  | { kind: "dismiss"; id: string };

export const initialBoardState: BoardState = { focus: 0, input: emptyInput, assigning: false };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const timeOf = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Fold a `list` reply into board data. Attention is oldest-first; sessions by name. */
export const boardDataOf = (reply: unknown): BoardData => {
  const roster = rosterOf(reply);
  const rawSessions = isObj(reply) && isObj(reply.sessions) ? reply.sessions : {};
  const rawAttention = isObj(reply) && Array.isArray(reply.attention) ? reply.attention : [];
  const created = new Map<string, number | null>();
  for (const a of rawAttention) if (isObj(a) && typeof a.id === "string") created.set(a.id, timeOf(a.createdAt));

  const attention = openAttentionOf(reply)
    .map((a): BoardItem => ({ ...a, name: sessionName(a.sessionId, roster), createdAt: created.get(a.id) ?? null }))
    .sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity));

  const toSession = (s: RosterSession): BoardSession => {
    const raw = rawSessions[s.id];
    const since = isObj(raw) ? timeOf(raw.lastActivity) : null;
    return { id: s.id, name: sessionName(s.id, roster), phase: s.phase, description: s.description ?? s.title, since };
  };
  const byName = (a: BoardSession, b: BoardSession): number => a.name.localeCompare(b.name);
  const running = roster.filter((s) => s.phase !== "idle").map(toSession).sort(byName);
  const idle = roster.filter((s) => s.phase === "idle").map(toSession).sort(byName);

  let orientation = "";
  if (isObj(reply) && isObj(reply.hub)) {
    if (typeof reply.hub.orientation === "string") orientation = reply.hub.orientation;
    else if (typeof reply.hub.digest === "string") orientation = reply.hub.digest;
  }
  if (orientation === "") orientation = `hub · ${plural(roster.length, "session")} · ${plural(attention.length, "item")} need you`;
  return { orientation: oneLine(orientation), attention, running, idle };
};

/** Machine-mode snapshot: `data` of the `hub --json` envelope. */
export const boardSnapshot = (data: BoardData): Record<string, unknown> => ({
  orientation: data.orientation,
  attention: data.attention.map(({ id, sessionId, kind, text, createdAt }) => ({
    id,
    sessionId,
    kind,
    text,
    createdAt: createdAt === null ? null : new Date(createdAt).toISOString(),
  })),
  running: data.running.map(({ id, phase, description }) => ({ id, phase, description })),
  idle: data.idle.map(({ id }) => ({ id })),
});

/** Compact age: 45s, 12m, 3h, 2d. */
export const formatAge = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

const slotCount = (data: BoardData): number => data.attention.length + data.idle.length;
const clampFocus = (focus: number, data: BoardData): number => Math.max(0, Math.min(focus, slotCount(data) - 1));

/** True when nothing needs the user and no session is idle (spec calm variant). */
export const isCalm = (data: BoardData): boolean => data.attention.length === 0 && data.idle.length === 0;

type Slot = { type: "attention"; item: BoardItem } | { type: "idle"; session: BoardSession };
const slotAt = (data: BoardData, i: number): Slot | undefined => {
  const item = data.attention[i];
  if (item !== undefined) return { type: "attention", item };
  const session = data.idle[i - data.attention.length];
  return session === undefined ? undefined : { type: "idle", session };
};

const NONE: BoardAction = { kind: "none" };

/** One key -> next state and the action for the caller to perform. */
export const boardKey = (state: BoardState, key: Key, data: BoardData): { state: BoardState; action: BoardAction } => {
  const at = (s: Partial<BoardState>, action: BoardAction = NONE) => ({ state: { ...state, ...s }, action });
  const focus = clampFocus(state.focus, data);
  const slot = slotAt(data, focus);
  const typing = state.input.text !== "" || state.assigning;

  if (key.kind === "quit") return at({}, { kind: "quit" });
  if (key.kind === "escape") return typing ? at({ input: emptyInput, assigning: false }) : at({}, { kind: "quit" });
  if (key.kind === "up") return at({ focus: clampFocus(focus - 1, data) });
  if (key.kind === "down") return at({ focus: clampFocus(focus + 1, data) });
  if (key.kind === "home") return at({ focus: 0 });
  if (key.kind === "end") return at({ focus: clampFocus(slotCount(data) - 1, data) });

  if (key.kind === "enter") {
    const text = state.input.text.trim();
    if (text === "" || slot === undefined) return at({ focus });
    const cleared = { focus, input: emptyInput, assigning: false };
    if (slot.type === "attention") return at(cleared, { kind: "answer", id: slot.item.id, text });
    if (state.assigning) return at(cleared, { kind: "assign", id: slot.session.id, text });
    return at({ focus });
  }

  if (!typing && key.kind === "char") {
    switch (key.ch) {
      case "q":
        return at({}, { kind: "quit" });
      case "l":
        return at({}, { kind: "log" });
      case "o":
        return at({}, { kind: "open" });
      case "d":
        return slot?.type === "attention" ? at({ focus }, { kind: "dismiss", id: slot.item.id }) : at({ focus });
      case "a":
        return slot?.type === "idle" ? at({ focus, assigning: true }) : at({ focus });
      default:
        break;
    }
  }

  // Text entry: answers on attention rows, tasks on idle rows only after `a`.
  if (slot?.type === "attention" || state.assigning) {
    const input = editInput(state.input, key);
    return input === state.input ? at({ focus }) : at({ focus, input });
  }
  return at({ focus });
};

const KIND_TONE: Record<string, ColorRef> = { approval: "warn", question: "accent", blocked: "err", idle: "muted" };
const PHASE_TONE: Record<string, ColorRef> = { working: "ok", waiting: "warn", blocked: "err" };

const section = (n: number, title: string, count: number, width: number, tone: ColorRef): Line =>
  padLine([sp(` [${n}] `, "muted"), sp(title, tone, { bold: true }), sp(`  ${count}`, "muted")], width, "panel");

const emptyRow = (width: number): Line => padLine([sp("   (empty)", "muted")], width);

/** The full board as exactly `height` lines of exactly `width` cells. */
export const boardLines = (state: BoardState, data: BoardData, width: number, height: number, now: number, piped = false): Line[] => {
  const calm = isCalm(data);
  const focus = clampFocus(state.focus, data);
  const age = (t: number | null): string => (t === null ? "" : formatAge(now - t));
  const focusBand = (line: Line, i: number): Line => (i === focus ? withBg(line, "band") : line);

  const body: Line[] = [];
  const status = splitLine(
    [sp(" "), sp(clipText(data.orientation, Math.max(0, width - 14)), calm ? "ok" : "fg", { bold: !calm })],
    [sp("hub v0.1.0 ", "muted")],
    width,
    "panel",
  );

  body.push(section(1, "Needs you", data.attention.length, width, data.attention.length > 0 ? "warn" : "muted"));
  if (data.attention.length === 0) body.push(emptyRow(width));
  data.attention.forEach((a, i) => {
    const left: Line = [
      sp("▎", { hue: a.sessionId }),
      sp(` ${a.kind.padEnd(8)} `, KIND_TONE[a.kind] ?? "muted"),
      sp(clipText(a.name, 14).padEnd(14), "fg", { bold: true }),
      sp(` ${oneLine(a.text)}`, "fg"),
    ];
    body.push(focusBand(splitLine(left, [sp(`${age(a.createdAt)} `, "muted")], width), i));
  });

  body.push(section(2, "Running", data.running.length, width, "ok"));
  if (data.running.length === 0) body.push(emptyRow(width));
  for (const s of data.running) {
    const left: Line = [
      sp("▎", { hue: s.id }),
      sp(" ● ", PHASE_TONE[s.phase] ?? "muted"),
      sp(clipText(s.name, 14).padEnd(14), "fg"),
      sp(` ${s.phase.padEnd(8)}`, PHASE_TONE[s.phase] ?? "muted"),
      sp(` ${oneLine(s.description)}`, "muted"),
    ];
    body.push(splitLine(left, [sp(`${age(s.since)} `, "muted")], width));
  }

  body.push(section(3, "Idle", data.idle.length, width, "muted"));
  if (data.idle.length === 0) body.push(emptyRow(width));
  data.idle.forEach((s, j) => {
    const left: Line = [sp("▎", { hue: s.id }), sp(" ○ ", "muted"), sp(clipText(s.name, 14).padEnd(14), "fg"), sp(" idle", "muted")];
    body.push(focusBand(splitLine(left, [sp(`${age(s.since)} `, "muted")], width), data.attention.length + j));
  });

  const avail = Math.max(0, height - 3);
  const shown = body.slice(0, avail);
  while (shown.length < avail) shown.push(padLine([], width));

  const prompt: Line = state.assigning
    ? [sp(" assign › ", "accent"), sp(state.input.text, "fg"), sp("█", "accent")]
    : state.input.text !== ""
      ? [sp(" answer › ", "accent"), sp(state.input.text, "fg"), sp("█", "accent")]
      : [];
  const foot = footerLine(footerMode({ calm, piped }), width);

  const all = height >= 3 ? [status, ...shown, padLine(prompt, width, "input"), foot] : [status, foot].slice(0, height);
  return all.slice(0, height);
};
