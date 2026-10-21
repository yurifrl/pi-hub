// cli/src/tui/footer.ts - the board's one-line keys hint (spec §hub (bare): footer).
// Three modes: full (something to act on), calm (nothing to act on), piped (no TTY).

import { lineWidth, padLine, sp, type Line } from "./colors";

export type FooterMode = "full" | "calm" | "piped";

type Segment = { key: string; label: string };

const FULL: readonly Segment[] = [
  { key: "↑↓", label: "move" },
  { key: "type", label: "to answer" },
  { key: "d", label: "dismiss" },
  { key: "a", label: "assign" },
  { key: "o", label: "open" },
  { key: "l", label: "log" },
  { key: "q", label: "quit" },
];

const CALM: readonly Segment[] = [
  { key: "l", label: "log" },
  { key: "q", label: "quit" },
];

/** piped = stdin/stdout is not a terminal; calm = nothing needs the user and no session is idle. */
export const footerMode = (opts: { calm: boolean; piped: boolean }): FooterMode =>
  opts.piped ? "piped" : opts.calm ? "calm" : "full";

const segmentLine = (segments: readonly Segment[]): Line => {
  const out: Line = [sp(" ")];
  segments.forEach((s, i) => {
    if (i > 0) out.push(sp(" · ", "muted"));
    out.push(sp(s.key, "fg", { bold: true }), sp(` ${s.label}`, "muted"));
  });
  return out;
};

/** Exactly `width` cells. Narrow terminals drop middle hints first; `q quit` always survives. */
export const footerLine = (mode: FooterMode, width: number): Line => {
  if (mode === "piped") return padLine([sp(" keys off", "muted")], width);
  const segments = [...(mode === "calm" ? CALM : FULL)];
  while (segments.length > 1 && lineWidth(segmentLine(segments)) > width) segments.splice(segments.length - 2, 1);
  return padLine(segmentLine(segments), width);
};
