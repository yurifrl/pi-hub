// cli/src/render/theme.ts — maps lib theme tokens to ANSI escape sequences
// (docs/03-cli.md §Rendering → Theme → ANSI). lib/theme.ts owns the tokens;
// this module owns the terminal encoding and the degrade ladder:
// truecolor → nearest 256-color cube entry → ANSI-16 → plain.
// NO_COLOR / --no-color / machine modes / non-TTY all land on "plain"
// (docs/03 §Output policies: machine output never carries ANSI).

import { TOKEN_RGB, cubeIndexToRgb, sessionHue, tokenColorCodes, type ThemeToken } from "@yurifrl/hub";

/** Rungs of the CLI color ladder (docs/03 §Theme → ANSI fallback chain). */
export type ColorLevel = "truecolor" | "256" | "16" | "plain";

/**
 * Detect the color level for one terminal. `color` folds in config.color
 * (NO_COLOR env and --no-color resolve earlier in config.ts) and the machine
 * output policy; `tty` is stdout's TTY-ness — a pipe means plain output
 * (docs/03 §TTY degradation).
 */
export const detectColorLevel = (env: NodeJS.ProcessEnv, tty: boolean, color: boolean): ColorLevel => {
  if (!color || !tty) return "plain";
  const colorterm = env.COLORTERM ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return "truecolor";
  const term = env.TERM ?? "";
  if (term.includes("256color")) return "256";
  if (term.includes("16color") || term.includes("direct")) return "16";
  return "16";
};

/**
 * Nearest 6×6×6 cube index (16–231) for an RGB triple — squared-distance
 * search over the 216 cube entries (docs/03: "nearest 256-color cube entry").
 */
export const nearestCubeIndex = (r: number, g: number, b: number): number => {
  let best = 16;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 216; i++) {
    const [cr, cg, cb] = cubeIndexToRgb(16 + i);
    const dr = cr - r;
    const dg = cg - g;
    const db = cb - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = 16 + i;
    }
  }
  return best;
};

/** The 16 base ANSI colors (30–37, 90–97) with their canonical RGB values. */
const ANSI16: readonly { codes: string; rgb: readonly [number, number, number] }[] = [
  { codes: "30", rgb: [0, 0, 0] },
  { codes: "31", rgb: [205, 0, 0] },
  { codes: "32", rgb: [0, 205, 0] },
  { codes: "33", rgb: [205, 205, 0] },
  { codes: "34", rgb: [0, 0, 238] },
  { codes: "35", rgb: [205, 0, 205] },
  { codes: "36", rgb: [0, 205, 205] },
  { codes: "37", rgb: [229, 229, 229] },
  { codes: "90", rgb: [127, 127, 127] },
  { codes: "91", rgb: [255, 0, 0] },
  { codes: "92", rgb: [0, 255, 0] },
  { codes: "93", rgb: [255, 255, 0] },
  { codes: "94", rgb: [92, 92, 255] },
  { codes: "95", rgb: [255, 0, 255] },
  { codes: "96", rgb: [0, 255, 255] },
  { codes: "97", rgb: [255, 255, 255] },
];

/** Nearest ANSI-16 foreground codes for an RGB triple. */
export const nearestAnsi16 = (r: number, g: number, b: number): string => {
  let best = ANSI16[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entry of ANSI16) {
    const dr = entry.rgb[0] - r;
    const dg = entry.rgb[1] - g;
    const db = entry.rgb[2] - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return best.codes;
};

/**
 * Foreground SGR parameters for a theme token or a session-hue cube index.
 * Cube index = `16 + sessionHue(id)` (docs/03 §Session hue). Empty string at
 * the "plain" rung — callers emit nothing.
 */
export const fgCodes = (fg: ThemeToken | number | undefined, level: ColorLevel): string => {
  if (fg === undefined || level === "plain") return "";
  if (typeof fg === "number") {
    const [r, g, b] = cubeIndexToRgb(fg);
    if (level === "truecolor") return `38;2;${r};${g};${b}`;
    if (level === "256") return `38;5;${fg}`;
    return nearestAnsi16(r, g, b);
  }
  if (level === "truecolor") return tokenColorCodes(fg);
  const [r, g, b] = TOKEN_RGB[fg];
  if (level === "256") return `38;5;${nearestCubeIndex(r, g, b)}`;
  return nearestAnsi16(r, g, b);
};

/** Background SGR parameters for a theme token (bg hues are not used). */
export const bgCodes = (bg: ThemeToken | undefined, level: ColorLevel): string => {
  if (bg === undefined || level === "plain") return "";
  const [r, g, b] = TOKEN_RGB[bg];
  if (level === "truecolor") return `48;2;${r};${g};${b}`;
  if (level === "256") return `48;5;${nearestCubeIndex(r, g, b)}`;
  return "";
};

/**
 * Session-hue cube index for a sessionId — the single call site every
 * painter uses, so CLI and web (which consumes the same lib helpers in
 * web/src/hue.ts) agree on a session's color (docs/03 §Session hue contract).
 */
export const hueIndex = (sessionId: string): number => 16 + sessionHue(sessionId);
