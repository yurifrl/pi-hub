// cli/src/log_render.ts — the scroll renderers shared by `log`/`summaries`
// human output and the watch piped static frame (docs/03-cli.md §Rendering:
// commands produce data, renderers produce frames). Wraps paintStreamLine +
// cellsToAnsi so bodies never touch ANSI themselves (docs/03 §Rendering).

import type { Cell, ThemeTokenOrHue } from "./render/screen";
import { cellsToAnsi } from "./render/screen";
import type { ColorLevel } from "./render/theme";
import { detectColorLevel } from "./render/theme";
import type { CommandContext } from "./commands";

/** Cells → printable row at the invocation's color level (plain when piped). */
export const renderRow = (cells: Cell[], level: ColorLevel): string =>
  level === "plain" ? cells.map((c) => c.ch).join("") : cellsToAnsi(cells, level);

/**
 * Color level for a command body: folds policy color (NO_COLOR/--no-color
 * resolved in config) with stdout TTY-ness (docs/03 §Theme → ANSI degrade
 * ladder; machine modes are plain because their policy color is false).
 */
export const colorLevelFor = (ctx: CommandContext): ColorLevel =>
  detectColorLevel(process.env, isTty(ctx.io.stdout), ctx.policy.color);

const isTty = (s: NodeJS.WritableStream): boolean =>
  s === process.stdout ? process.stdout.isTTY === true : (s as { isTTY?: boolean }).isTTY === true;

/** Segments → cells (no hue bar) — used by footers and hint lines. */
export const segCells = (segs: [string, ThemeTokenOrHue | undefined][]): Cell[] => {
  const cells: Cell[] = [];
  for (const [text, style] of segs) {
    for (const ch of text) cells.push({ ch, ...(style !== undefined ? { fg: style } : {}) });
  }
  return cells;
};

/** Muted row builder for hints/footers. */
export const mutedRow = (text: string): Cell[] => segCells([[text, "muted"]]);
