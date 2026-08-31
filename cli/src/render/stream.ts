// cli/src/render/stream.ts — log and summary line painter (docs/03-cli.md
// §Rendering → stream.ts): hue bars, kind glyphs, wrapping aligned to the
// text column, viewport scrolling with scrollback, pinned/filtered selection.
// Pure: entries in → lines/cells out; screen.ts owns escape encoding.

import type { LogEntry, SummaryLine } from "@yurifrl/hub";
import type { Cell } from "./screen";
import type { ThemeTokenOrHue } from "./screen";

/** kind → glyph (docs/03 sketch 3: ▶ tool, ✔ exit, ✎ edit, ⚠ attention). */
export const kindGlyph = (kind: LogEntry["kind"]): string => {
  switch (kind) {
    case "tool_call":
      return "▶";
    case "agent_end":
      return "✔";
    case "user_message":
      return "❯";
    case "assistant_message":
      return "·";
    default:
      return "·";
  }
};

/** summaries kind → row token (docs/03 §summaries: summary warn, resolution ok). */
export const summaryToken = (kind: SummaryLine["kind"]): ThemeTokenOrHue =>
  kind === "summary" ? "warn" : "ok";

/** `HH:MM:SS` from an epoch-ms value. */
export const clockOf = (t: number): string => {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Text column width: `▎▎ HH:MM:SS name glyph ` prefix. */
export const TEXT_COL = 2 + 9 + 8 + 2; // = 21

/** One wrapped stream line's segments before cell encoding. */
export type StreamLine = {
  /** session hue for the leading two-cell bar; null = no bar */
  hueSessionId?: string;
  segs: [string, ThemeTokenOrHue | undefined][];
};

/** Timestamp segment style — muted (docs/03: timestamps render muted). */
const MUTED: ThemeTokenOrHue = "muted";

/** Wrap `text` into chunks of `width` cells. */
export const wrapText = (text: string, width: number): string[] => {
  if (width <= 0) return [text];
  if (text.length <= width) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
};

/**
 * Log entries → stream lines. Continuation lines wrap aligned under the text
 * column with an empty bar (docs/03 §log: "Long lines wrap aligned under the
 * text column").
 */
export const streamLines = (entries: LogEntry[], hueIndex: (id: string) => number, width = 0): StreamLine[] => {
  const lines: StreamLine[] = [];
  for (const e of entries) {
    const time = clockOf(e.t);
    const name = e.sessionId.slice(0, 8);
    const glyph = kindGlyph(e.kind);
    const head = `${time} ${name.padEnd(8)} ${glyph} `;
    const textCol = head.length;
    const chunks = wrapText(e.text, width > textCol ? width - textCol : 0);
    const parts = chunks.length > 0 ? chunks : [""];
    parts.forEach((chunk, i) => {
      const prefix = i === 0 ? head : " ".repeat(textCol);
      lines.push({
        hueSessionId: e.sessionId,
        segs: [
          ["▎▎ ", hueIndex(e.sessionId)],
          [`${prefix}${chunk}`, MUTED],
        ],
      });
    });
  }
  return lines;
};

/**
 * Summary lines → stream lines: `▎▎ <muted time> <by> <text>` (docs/03
 * §summaries human row), summary rows warn, resolution rows ok.
 */
export const summaryStreamLines = (lines: SummaryLine[], hueIndex: (id: string) => number): StreamLine[] =>
  lines.map((l) => ({
    hueSessionId: l.sessionId,
    segs: [
      ["▎▎ ", hueIndex(l.sessionId)],
      [`${clockOf(Date.parse(l.t))} ${l.by} `, MUTED],
      [l.text, summaryToken(l.kind)],
    ],
  }));

/** Cells for one StreamLine (the painter proper). */
export const paintStreamLine = (line: StreamLine): Cell[] => {
  const cells: Cell[] = [];
  for (const [text, style] of line.segs) {
    for (const ch of text) cells.push({ ch, ...(style !== undefined ? { fg: style } : {}) });
  }
  return cells;
};

/**
 * Viewport over painted lines: last `rows` lines (scrollback = caller keeps
 * more history and calls with a window). Pinned + filter selection are input
 * concerns handled by the watch screen; the painter only slices.
 */
export const viewport = (lines: Cell[][], rows: number): Cell[][] => (lines.length > rows ? lines.slice(lines.length - rows) : lines);

/** Filter entries by substring across session name and entry text. */
export const filterEntries = (entries: LogEntry[], query: string): LogEntry[] => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...entries];
  return entries.filter((e) => e.text.toLowerCase().includes(q) || e.sessionId.toLowerCase().includes(q));
};

/** Cells for the muted static-frame hint (docs/03 §TTY degradation). */
export const PIPED_HINT = "run hub in a terminal for live view";
