// cli/src/tui/picker.ts — full-screen session picker for `hub send` / `hub assign`
// (spec sketch 4). Pure state + line builders (testable) and a thin OpenTUI shell.
//
// Stage "pick": type to filter, ↑↓ move, ⏎ select, esc cancel.
// Stage "message": opens on the chosen row (`› █`); ⏎ delivers, esc goes back to the list.
// With a pre-supplied message the picker returns right after selection.

import { createCliRenderer } from "@opentui/core";
import type { CliContext } from "../context";
import { rosterOf, type RosterSession } from "../ids";
import { clipText, linesText, makePalette, oneLine, padLine, paintLines, sp, splitLine, textWidth, withBg, type Line, type Span } from "./colors";
import { decodeKey, editInput, emptyInput, type Key, type TextInput } from "./keys";

export type PickOptions = {
  query: string;
  message?: string;
  phase?: string;
  /** pre-supplied candidates (skips the `list` socket call — hub-less commands like `log`) */
  rows?: readonly RosterSession[];
  /** header verb override */
  verb?: string;
};
export type Picked = { id: string; message: string | null };

export type PickerState = {
  stage: "pick" | "message";
  query: TextInput;
  message: TextInput;
  /** index into the filtered rows */
  sel: number;
  chosen: string | null;
};

export type PickerStep =
  | { state: PickerState; done?: undefined }
  | { state: PickerState; done: { cancelled: true } }
  | { state: PickerState; done: { id: string; message: string | null } };

const name = (s: RosterSession): string => {
  const parts = s.cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || s.id.slice(0, 8);
};
const titleOf = (s: RosterSession): string => oneLine(s.description || s.title);

/** Rows matching the query (case-insensitive substring over name, title, id, phase). */
export const filterRows = (rows: readonly RosterSession[], query: string): RosterSession[] => {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((s) => `${name(s)} ${titleOf(s)} ${s.id} ${s.phase}`.toLowerCase().includes(q));
};

export const initialPickerState = (opts: PickOptions): PickerState => {
  const chars = [...opts.query].length;
  return { stage: "pick", query: { text: opts.query, cursor: chars }, message: emptyInput, sel: 0, chosen: null };
};

const clampSel = (sel: number, n: number): number => (n === 0 ? 0 : Math.max(0, Math.min(sel, n - 1)));

/** One key → next state. `rows` is the unfiltered candidate list. */
export const stepPicker = (state: PickerState, key: Key, rows: readonly RosterSession[], opts: PickOptions): PickerStep => {
  if (key.kind === "quit") return { state, done: { cancelled: true } };
  if (state.stage === "message") {
    if (key.kind === "escape") return { state: { ...state, stage: "pick", chosen: null } };
    if (key.kind === "enter") {
      const text = state.message.text.trim();
      if (text === "") return { state };
      return { state, done: { id: state.chosen ?? "", message: text } };
    }
    return { state: { ...state, message: editInput(state.message, key) } };
  }
  const shown = filterRows(rows, state.query.text);
  switch (key.kind) {
    case "escape":
      return { state, done: { cancelled: true } };
    case "up":
      return { state: { ...state, sel: clampSel(state.sel - 1, shown.length) } };
    case "down":
      return { state: { ...state, sel: clampSel(state.sel + 1, shown.length) } };
    case "pageup":
      return { state: { ...state, sel: clampSel(state.sel - 8, shown.length) } };
    case "pagedown":
      return { state: { ...state, sel: clampSel(state.sel + 8, shown.length) } };
    case "enter": {
      const pick = shown[clampSel(state.sel, shown.length)];
      if (pick === undefined) return { state };
      if (opts.message !== undefined) return { state, done: { id: pick.id, message: opts.message } };
      return { state: { ...state, stage: "message", chosen: pick.id, message: emptyInput } };
    }
    default: {
      const query = editInput(state.query, key);
      if (query === state.query) return { state };
      return { state: { ...state, query, sel: 0 } };
    }
  }
};

const inputSpans = (input: TextInput, caret: boolean): Span[] => {
  const chars = [...input.text];
  const before = chars.slice(0, input.cursor).join("");
  const at = chars[input.cursor];
  const after = chars.slice(input.cursor + 1).join("");
  if (!caret) return [sp(input.text)];
  return [sp(before), sp(at ?? " ", "fg", { bold: true, bg: "band" }), sp(after)];
};

/** The whole screen as lines, exactly `height` rows of `width` cells. */
export const pickerLines = (
  state: PickerState,
  rows: readonly RosterSession[],
  verb: string,
  width: number,
  height: number,
): Line[] => {
  const out: Line[] = [];
  const w = Math.max(20, width);
  const shown = filterRows(rows, state.query.text);
  const sel = clampSel(state.sel, shown.length);
  const header: Line = [sp(` hub ${verb}`, "accent", { bold: true }), sp(" — pick a session ", "muted")];
  if (state.stage === "pick") {
    out.push(withBg(padLine([...header, sp("▏", "muted"), ...inputSpans(state.query, true)], w), "panel"));
  } else {
    out.push(withBg(padLine([...header, sp("▏", "muted"), sp(state.query.text)], w), "panel"));
  }
  const bodyRows = Math.max(1, height - 3);
  const nameW = Math.min(14, Math.max(4, ...shown.map((s) => textWidth(name(s)))));
  const phaseW = Math.max(5, ...shown.map((s) => s.phase.length));
  const first = Math.max(0, Math.min(sel - Math.floor(bodyRows / 2), Math.max(0, shown.length - bodyRows)));
  if (shown.length === 0) {
    out.push([sp(" no matching sessions", "muted")]);
  }
  for (const [i, s] of shown.slice(first, first + bodyRows).entries()) {
    const idx = first + i;
    const focused = idx === sel;
    const chosen = state.stage === "message" && s.id === state.chosen;
    const phaseTok = s.phase === "working" ? "ok" : s.phase === "blocked" ? "err" : s.phase === "waiting" ? "warn" : "muted";
    const room = Math.max(4, w - nameW - phaseW - 9);
    const base: Line = [
      sp("▎", { hue: s.id }),
      sp(focused || chosen ? " ▸ " : "   ", "accent"),
      sp(clipText(name(s), nameW).padEnd(nameW), "fg", { bold: focused }),
      sp("  "),
      sp(clipText(titleOf(s), room).padEnd(room), focused ? "fg" : "muted"),
      sp(" "),
      sp(s.phase, phaseTok),
    ];
    out.push(focused || chosen ? withBg(padLine(base, w), "band") : padLine(base, w));
  }
  while (out.length < height - 2) out.push([]);
  if (state.stage === "message") {
    out.length = Math.min(out.length, height - 2);
    out.push(withBg(padLine([sp(" › ", "accent", { bold: true }), ...inputSpans(state.message, true)], w), "input"));
    out.push(padLine([sp(" ⏎ deliver · esc back · ^c cancel", "muted")], w));
  } else {
    out.length = Math.min(out.length, height - 1);
    out.push(splitLine([sp(" ↑↓ move · ⏎ select · esc cancel · type to filter", "muted")], [sp(`${shown.length} `, "muted")], w));
  }
  return out.slice(0, height);
};

/** Candidate sessions for the picker: optional phase filter, stable by name. */
export const candidatesOf = (listReply: unknown, phase?: string): RosterSession[] =>
  rosterOf(listReply)
    .filter((s) => phase === undefined || s.phase === phase)
    .sort((a, b) => name(a).localeCompare(name(b)) || a.id.localeCompare(b.id));

/**
 * Full-screen session picker. Resolves null when cancelled. Restores the terminal on
 * every exit path (selection, esc, ctrl-c, SIGINT/SIGTERM).
 */
export const pickSession = async (ctx: CliContext, opts: PickOptions): Promise<Picked | null> => {
  const rows = opts.rows ?? candidatesOf(await ctx.call("list", {}), opts.phase);
  const verb = opts.verb ?? (opts.phase === "idle" ? "assign" : "send");
  const palette = makePalette(ctx.policy.color);
  let state = initialPickerState(opts);

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    exitSignals: ["SIGINT", "SIGTERM"],
    useMouse: false,
    backgroundColor: palette.base,
  });
  const result = Promise.withResolvers<Picked | null>();
  let finished = false;
  const finish = (value: Picked | null): void => {
    if (finished) return;
    finished = true;
    if (!renderer.isDestroyed) renderer.destroy();
    result.resolve(value);
  };

  renderer.addPostProcessFn((buffer) => {
    paintLines(buffer, pickerLines(state, rows, verb, buffer.width, buffer.height), palette);
  });
  renderer.keyInput.on("keypress", (ev) => {
    const step = stepPicker(state, decodeKey(ev), rows, opts);
    state = step.state;
    if (step.done === undefined) {
      renderer.requestRender();
    } else if ("cancelled" in step.done) {
      finish(null);
    } else {
      finish(step.done);
    }
  });
  renderer.on("destroy", () => finish(null));
  renderer.requestRender();
  return result.promise;
};

/** Plain text of the picker for tests/snapshots. */
export const pickerText = (state: PickerState, rows: readonly RosterSession[], verb: string, w: number, h: number): string =>
  linesText(pickerLines(state, rows, verb, w, h));
