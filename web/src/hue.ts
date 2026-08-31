// web/src/hue.ts — per-session hue for the console (docs/04-web.md §Server:
// CSS custom properties `--hue-<sessionId>`; the theme is defined once in lib
// and injected here — the web package never hardcodes a hex value).
// Pure module: no I/O.

import { cubeIndexToRgb, hashSessionId } from "@yurifrl/hub";

/**
 * sessionId → `--hue-<sessionId>: rgb(r g b);` CSS custom-property
 * declarations for one page. Duplicates collapse; deterministic order.
 */
export const hueVars = (sessionIds: string[]): string =>
  [...new Set(sessionIds)]
    .sort()
    .map((id) => {
      const [r, g, b] = cubeIndexToRgb(16 + (hashSessionId(id) % 216));
      return `--hue-${id}: rgb(${r} ${g} ${b});`;
    })
    .join("");
