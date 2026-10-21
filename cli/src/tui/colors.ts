// cli/src/tui/colors.ts - theme tokens -> OpenTUI RGBA, plus the styled-span model
// every full-screen surface (board, watch, log, picker) draws with. Layout code
// produces `Line[]` of semantic spans; `paintLines` resolves them through a Palette
// onto an OpenTUI buffer. Nothing here writes raw ANSI.

import { RGBA, TextAttributes, type OptimizedBuffer } from "@opentui/core";
import { TOKEN_RGB, cubeIndexToRgb, sessionHue, type ThemeToken } from "@yurifrl/hub";

/** Foreground reference: a theme token, neutral text, or a session hue bar color. */
export type ColorRef = ThemeToken | "fg" | { hue: string };
/** Background reference: flat chrome layers (neutral, not theme tokens). */
export type BgRef = "base" | "panel" | "band" | "input";

export type Span = {
  t: string;
  fg?: ColorRef;
  bg?: BgRef;
  bold?: boolean;
  dim?: boolean;
};
export type Line = Span[];

export type Palette = {
  color: boolean;
  fg(ref: ColorRef): RGBA;
  bg(ref: BgRef): RGBA;
  /** OpenTUI backgroundColor for the renderer (undefined = terminal default). */
  base: RGBA;
};

const NEUTRAL_FG: [number, number, number] = [215, 222, 234];
const BG_RGB: Record<BgRef, [number, number, number]> = {
  base: [13, 16, 22],
  panel: [19, 23, 31],
  band: [35, 42, 56],
  input: [24, 29, 40],
};

const rgba = ([r, g, b]: [number, number, number]): RGBA => RGBA.fromInts(r, g, b, 255);

/** Theme token -> RGBA (truecolor; OpenTUI quantizes for lesser terminals). */
export const tokenRgba = (token: ThemeToken): RGBA => rgba(TOKEN_RGB[token]);

/** Session hue bar color: cube index `16 + hash(id) mod 216`, derived from the id only. */
export const hueRgba = (sessionId: string): RGBA => rgba(cubeIndexToRgb(16 + sessionHue(sessionId)));

const colorPalette: Palette = {
  color: true,
  fg: (ref) => (ref === "fg" ? rgba(NEUTRAL_FG) : typeof ref === "string" ? tokenRgba(ref) : hueRgba(ref.hue)),
  bg: (ref) => rgba(BG_RGB[ref]),
  base: rgba(BG_RGB.base),
};

/** --no-color / NO_COLOR: terminal-default fg and bg everywhere; weight carries emphasis. */
const plainPalette: Palette = {
  color: false,
  fg: () => RGBA.defaultForeground(),
  bg: () => RGBA.defaultBackground(),
  base: RGBA.defaultBackground(),
};

export const makePalette = (color: boolean): Palette => (color ? colorPalette : plainPalette);

// ---- span / line helpers ----------------------------------------------------

export const sp = (t: string, fg?: ColorRef, extra: Omit<Span, "t" | "fg"> = {}): Span =>
  fg === undefined ? { t, ...extra } : { t, fg, ...extra };

/** Collapse whitespace and strip control characters so one value never breaks a row. */
export const oneLine = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();

export const textWidth = (s: string): number => Bun.stringWidth(s);

/** Truncate to `max` display cells, ending in an ellipsis when cut. */
export const clipText = (s: string, max: number): string => {
  if (max <= 0) return "";
  if (textWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = textWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
};

export const lineWidth = (line: Line): number => line.reduce((n, s) => n + textWidth(s.t), 0);

/** Clip a line to `max` cells (ellipsis on the span that overflows). */
export const clipLine = (line: Line, max: number): Line => {
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    const w = textWidth(s.t);
    if (used + w <= max) {
      out.push(s);
      used += w;
      continue;
    }
    const room = max - used;
    if (room > 0) out.push({ ...s, t: clipText(s.t, room) });
    return out;
  }
  return out;
};

/** Clip then right-pad with spaces (carrying `bg`) to exactly `width` cells. */
export const padLine = (line: Line, width: number, bg?: BgRef): Line => {
  const clipped = clipLine(line, width);
  const pad = width - lineWidth(clipped);
  if (pad <= 0) return clipped;
  return [...clipped, bg === undefined ? { t: " ".repeat(pad) } : { t: " ".repeat(pad), bg }];
};

/** `left` flush left, `right` flush right, filling the gap; right wins when they collide. */
export const splitLine = (left: Line, right: Line, width: number, bg?: BgRef): Line => {
  const rw = lineWidth(right);
  if (rw >= width) return padLine(right, width, bg);
  const l = clipLine(left, Math.max(0, width - rw - 1));
  const gap = width - lineWidth(l) - rw;
  return [...l, bg === undefined ? { t: " ".repeat(gap) } : { t: " ".repeat(gap), bg }, ...right];
};

/** Apply a background to every span that has none. */
export const withBg = (line: Line, bg: BgRef): Line => line.map((s) => (s.bg === undefined ? { ...s, bg } : s));

/** Plain text of a line / screen (tests, static frames, change detection). */
export const lineText = (line: Line): string => line.map((s) => s.t).join("");
export const linesText = (lines: Line[]): string => lines.map(lineText).join("\n");

// ---- painter ----------------------------------------------------------------

/** Clear the buffer and draw `lines` top-down from (x0, y0). Rows past the buffer are dropped. */
export const paintLines = (buffer: OptimizedBuffer, lines: Line[], palette: Palette, x0 = 0, y0 = 0): void => {
  buffer.clear(palette.base);
  const maxY = buffer.height;
  lines.forEach((line, i) => {
    const y = y0 + i;
    if (y >= maxY) return;
    let x = x0;
    for (const s of line) {
      if (s.t.length === 0) continue;
      let attrs = TextAttributes.NONE;
      if (s.bold === true) attrs |= TextAttributes.BOLD;
      if (s.dim === true) attrs |= TextAttributes.DIM;
      buffer.drawText(s.t, x, y, palette.fg(s.fg ?? "fg"), palette.bg(s.bg ?? "base"), attrs);
      x += textWidth(s.t);
    }
  });
};
