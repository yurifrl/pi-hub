// lib/theme.ts — the one theme definition: tokens, palette, session-hue hash.
// Every surface consumes these tokens; none redefines them (docs/01 §DRY rules,
// docs/03 §Rendering). Pure module: no side effects at load.

/** The five semantic theme tokens (docs/01 §DRY rules table). */
export type ThemeToken = "accent" | "ok" | "warn" | "err" | "muted";

export const TOKENS: readonly ThemeToken[] = ["accent", "ok", "warn", "err", "muted"] as const;

/** token → hex value, the single source of truth (docs/03 §Theme → ANSI table). */
export const TOKEN_HEX: Record<ThemeToken, string> = {
  accent: "#70e1c4",
  ok: "#3fd68f",
  warn: "#f5c04e",
  err: "#ff7a9a",
  muted: "#8b97b0",
};

/** token → RGB, derived once from TOKEN_HEX. */
export const TOKEN_RGB: Record<ThemeToken, [number, number, number]> = {
  accent: hexToRgb(TOKEN_HEX.accent),
  ok: hexToRgb(TOKEN_HEX.ok),
  warn: hexToRgb(TOKEN_HEX.warn),
  err: hexToRgb(TOKEN_HEX.err),
  muted: hexToRgb(TOKEN_HEX.muted),
};

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * session-hue = hash(sessionId) mod 216, rendered as cube index `16 + h` —
 * the 6×6×6 cube, skipping the 16 base terminal colors (docs/03 §Session hue).
 * The hue derives only from sessionId, never the name, so CLI and web agree
 * on a session's color across every surface.
 */
export const sessionHue = (sessionId: string): number => hashSessionId(sessionId) % 216;

/** Truecolor escape prefix for a theme token: `38;2;r;g;b` (no wrapper). */
export const tokenColorCodes = (token: ThemeToken): string => {
  const [r, g, b] = TOKEN_RGB[token];
  return `38;2;${r};${g};${b}`;
};

/** Truecolor escape prefix for a session hue cube index. */
export const hueColorCodes = (sessionId: string): string => {
  const i = sessionHue(sessionId);
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const sr = r === 0 ? 0 : 55 + r * 40;
  const sg = g === 0 ? 0 : 55 + g * 40;
  const sb = b === 0 ? 0 : 55 + b * 40;
  return `38;2;${sr};${sg};${sb}`;
};

/** 6×6×6 cube index (16–231) → truecolor codes. */
export const cubeIndexToCodes = (index: number): string => {
  const i = index - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const sr = r === 0 ? 0 : 55 + r * 40;
  const sg = g === 0 ? 0 : 55 + g * 40;
  const sb = b === 0 ? 0 : 55 + b * 40;
  return `38;2;${sr};${sg};${sb}`;
};

/**
 * FNV-1a 32-bit over the UTF-8 bytes of sessionId — stable across processes
 * and runtimes, so CLI and web hash identically (docs/03 contract).
 */
export const hashSessionId = (sessionId: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    const code = sessionId.charCodeAt(i);
    if (code < 0x80) {
      h ^= code;
      h = Math.imul(h, 0x01000193);
    } else if (code < 0x800) {
      h ^= 0xc0 | (code >> 6);
      h = Math.imul(h, 0x01000193);
      h ^= 0x80 | (code & 0x3f);
      h = Math.imul(h, 0x01000193);
    } else {
      h ^= 0xe0 | (code >> 12);
      h = Math.imul(h, 0x01000193);
      h ^= 0x80 | ((code >> 6) & 0x3f);
      h = Math.imul(h, 0x01000193);
      h ^= 0x80 | (code & 0x3f);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
};
