// cli/src/paint.ts — the one place commands turn theme tokens into ANSI.
// Identity when the policy has color off (--no-color, machine modes, NO_COLOR).

import { tokenColorCodes, type ThemeToken } from "@yurifrl/hub";
import type { OutputPolicy } from "./output";

export const painter =
  (policy: OutputPolicy): ((token: ThemeToken, text: string) => string) =>
  (token, text) =>
    policy.color ? `\x1b[${tokenColorCodes(token)}m${text}\x1b[39m` : text;
