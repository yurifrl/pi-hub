// cli/src/render/screen.ts — the double-buffer diff screen (docs/03-cli.md
// §Rendering → Screen buffer). Owns every raw ANSI byte emitted by the CLI:
// cell grid, diffing, minimal flush, alt-screen enter/leave, cursor moves.
// Painters (board.ts, stream.ts) produce Cell grids; they never emit escape
// sequences themselves.

import { fgCodes, bgCodes, type ColorLevel } from "./theme";
import type { ThemeToken } from "@yurifrl/hub";

/** One terminal cell: character plus its styling (docs/03 §Screen buffer). */
export type Cell = { ch: string; fg?: ThemeTokenOrHue; bg?: ThemeToken; bold?: boolean };

/** Foreground is either a theme token or a session-hue cube index. */
export type ThemeTokenOrHue = ThemeToken | number;

/** SGR wrapper: one cell's attributes → prefix + reset pair. */
export const cellSgr = (cell: Cell, level: ColorLevel): { on: string; off: string } => {
  const parts: string[] = [];
  const fg = fgCodes(cell.fg, level);
  if (fg.length > 0) parts.push(fg);
  const bg = bgCodes(cell.bg, level);
  if (bg.length > 0) parts.push(bg);
  if (cell.bold === true) parts.push("1");
  return parts.length === 0 ? { on: "", off: "" } : { on: `\x1b[${parts.join(";")}m`, off: "\x1b[0m" };
};

/** Escape-sequence vocabulary the CLI uses (docs/03 §Alt-screen lifecycle). */
export const SEQ = {
  smcup: "\x1b[?1049h",
  rmcup: "\x1b[?1049l",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  home: "\x1b[H",
  clearScreen: "\x1b[2J",
} as const;

/** Cursor-to sequence for a 1-indexed position. */
export const cursorTo = (row: number, col: number): string => `\x1b[${row};${col}H`;

/**
 * Alt-screen + raw-mode lifecycle owner. Enter once, restore on every exit
 * path, idempotent on double-exit (docs/03 §Alt-screen lifecycle: "restore
 * the terminal on every exit path — q, ctrl-c, error, crash").
 *
 * `write` emits to the terminal; `setRaw` toggles stdin raw mode (echo dies
 * with raw mode, so restoring cooked mode restores echo).
 */
export class TerminalState {
  private entered = false;

  constructor(
    private readonly emit: (s: string) => void,
    private readonly setRaw: (on: boolean) => void,
  ) {}

  /** smcup + hide cursor + raw stdin. No-op when already inside. */
  enter(): void {
    if (this.entered) return;
    this.emit(SEQ.smcup + SEQ.hideCursor);
    this.setRaw(true);
    this.entered = true;
  }

  /** Restore buffer + cursor + echo. Safe to call twice (docs/03: idempotent). */
  restore(): void {
    if (!this.entered) return;
    this.setRaw(false);
    this.emit(SEQ.showCursor + SEQ.rmcup);
    this.entered = false;
  }

  /** True while the alt screen is active. */
  get active(): boolean {
    return this.entered;
  }
}

/**
 * The ScreenBuffer: cell grid in, minimal ANSI out (docs/03 §Screen buffer).
 * `flush()` diffs the staged frame against the previously flushed frame and
 * emits cursor moves + changed spans only; a zero-diff frame writes nothing.
 */
export class ScreenBuffer {
  private cols = 0;
  private rows = 0;
  /** Previously flushed frame — the diff baseline. */
  private prev: Cell[][] = [];
  /** Frame staged by write(), flushed by flush(). */
  private staged: Cell[][] = [];
  private stagedDirty = true;
  private inAlt = false;
  private fullPaint = true;

  constructor(
    private readonly emit: (s: string) => void,
    private level: ColorLevel = "truecolor",
  ) {}

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.staged = [];
    this.stagedDirty = true;
    // A resize can leave stale glyphs outside the new grid — repaint fully.
    this.fullPaint = true;
  }

  /** Stage a full frame; the diff against prev happens at flush time. */
  write(cells: Cell[][]): void {
    this.staged = cells;
    this.stagedDirty = true;
  }

  /**
   * Emit minimal ANSI for staged-vs-prev differences. Returns the byte count
   * written; 0 when nothing changed. Clears to end-of-line after each row so
   * shorter replacement rows erase leftovers.
   */
  flush(): number {
    if (!this.stagedDirty) return 0;
    this.stagedDirty = false;
    const cells = this.staged;
    let out = "";
    if (this.fullPaint) {
      out += SEQ.home + SEQ.clearScreen;
      this.fullPaint = false;
    }
    const rows = Math.max(cells.length, this.prev.length);
    for (let r = 0; r < rows; r++) {
      const cur = cells[r] ?? [];
      const before = this.prev[r] ?? [];
      if (cellsEqual(cur, before)) continue;
      out += cursorTo(r + 1, 1);
      out += this.renderRow(cur);
      out += "\x1b[K"; // clear to EOL — shorter rows erase leftovers
    }
    this.prev = cells;
    if (out.length === 0) return 0;
    this.emit(out);
    return out.length;
  }

  private renderRow(cells: Cell[]): string {
    let out = "";
    let sgr = "";
    for (const cell of cells) {
      const { on, off } = cellSgr(cell, this.level);
      if (on !== sgr) {
        out += on.length > 0 ? on : "\x1b[0m";
        sgr = on;
      }
      out += cell.ch;
      if (off.length > 0) sgr = "";
    }
    if (sgr.length > 0) out += "\x1b[0m";
    return out;
  }

  /** Enter alt-screen: smcup + hide cursor; next flush paints fully. */
  enterAlt(): void {
    if (this.inAlt) return;
    this.emit(SEQ.smcup + SEQ.hideCursor);
    this.inAlt = true;
    this.prev = [];
    this.fullPaint = true;
  }

  /** Leave alt-screen: show cursor + rmcup. Idempotent (docs/03). */
  leaveAlt(): void {
    if (!this.inAlt) return;
    this.emit(SEQ.showCursor + SEQ.rmcup);
    this.inAlt = false;
    this.prev = [];
    this.fullPaint = true;
    this.stagedDirty = true;
  }

  /** Whether the alt screen is active. */
  get altActive(): boolean {
    return this.inAlt;
  }

  /** Current color level (theme.ts owns the mapping; screen carries it). */
  get colorLevel(): ColorLevel {
    return this.level;
  }
}

const cellsEqual = (a: Cell[], b: Cell[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.ch !== y.ch || x.fg !== y.fg || x.bg !== y.bg || x.bold !== y.bold) return false;
  }
  return true;
};

/** Build a Cell row from plain text (no styling). */
export const textRow = (text: string): Cell[] => text.split("").map((ch) => ({ ch }));

/** Pad or trim one row to `width` cells. */
export const padRow = (cells: Cell[], width: number): Cell[] => {
  if (cells.length === width) return cells;
  if (cells.length > width) return cells.slice(0, width);
  return [...cells, ...Array.from({ length: width - cells.length }, () => ({ ch: " " }))];
};
