// cli/src/render/theme.test.ts — theme token → ANSI mapping, degrade ladder
// (docs/03 §Theme → ANSI), session-hue consistency (same id → same cube color).
import { describe, it, expect } from "bun:test";
import { TOKEN_RGB, TOKENS, sessionHue, cubeIndexToCodes, hueColorCodes, hashSessionId } from "@yurifrl/hub";
import {
  detectColorLevel,
  fgCodes,
  bgCodes,
  nearestCubeIndex,
  nearestAnsi16,
  hueIndex,
  type ColorLevel,
} from "./theme";

describe("detectColorLevel — degrade ladder", () => {
  it("NO_COLOR / no-color / non-TTY land on plain", () => {
    expect(detectColorLevel({}, false, true)).toBe("plain");
    expect(detectColorLevel({ NO_COLOR: "1" }, true, false)).toBe("plain");
    expect(detectColorLevel({}, true, false)).toBe("plain");
  });

  it("COLORTERM truecolor → truecolor", () => {
    expect(detectColorLevel({ COLORTERM: "truecolor" }, true, true)).toBe("truecolor");
    expect(detectColorLevel({ COLORTERM: "24bit" }, true, true)).toBe("truecolor");
  });

  it("TERM 256color → 256", () => {
    expect(detectColorLevel({ TERM: "xterm-256color" }, true, true)).toBe("256");
  });

  it("plain TERM without 256 → 16 rung", () => {
    expect(detectColorLevel({ TERM: "vt100" }, true, true)).toBe("16");
    expect(detectColorLevel({}, true, true)).toBe("16");
  });
});

describe("token → truecolor codes (docs/03 table)", () => {
  it("accent/ok/warn/err/muted match the spec column", () => {
    expect(fgCodes("accent", "truecolor")).toBe("38;2;112;225;196");
    expect(fgCodes("ok", "truecolor")).toBe("38;2;63;214;143");
    expect(fgCodes("warn", "truecolor")).toBe("38;2;245;192;78");
    expect(fgCodes("err", "truecolor")).toBe("38;2;255;122;154");
    expect(fgCodes("muted", "truecolor")).toBe("38;2;139;151;176");
  });

  it("every token has exact TOKEN_HEX → TOKEN_RGB agreement", () => {
    for (const t of TOKENS) {
      const [r, g, b] = TOKEN_RGB[t];
      expect(fgCodes(t, "truecolor")).toBe(`38;2;${r};${g};${b}`);
    }
  });

  it("plain rung returns empty prefixes", () => {
    for (const t of TOKENS) expect(fgCodes(t, "plain")).toBe("");
    expect(bgCodes("accent", "plain")).toBe("");
    expect(fgCodes(undefined, "truecolor")).toBe("");
  });
});

describe("256 rung — nearest cube entry", () => {
  it("exact cube colors map to themselves", () => {
    expect(nearestCubeIndex(0, 0, 0)).toBe(16);
    expect(nearestCubeIndex(255, 255, 255)).toBe(231);
    expect(nearestCubeIndex(255, 0, 0)).toBe(196);
  });

  it("token codes carry 38;5;<n> form", () => {
    const code = fgCodes("accent", "256");
    expect(code).toMatch(/^38;5;\d+$/);
    const n = Number.parseInt(code.split(";")[2]!, 10);
    expect(n).toBeGreaterThanOrEqual(16);
    expect(n).toBeLessThanOrEqual(231);
  });

  it("hue indexes pass through as 38;5;n", () => {
    const idx = hueIndex("s-9f2c");
    expect(fgCodes(idx, "256")).toBe(`38;5;${idx}`);
  });
});

describe("16 rung — nearest ANSI base color", () => {
  it("maps greens to 92, reds to 91", () => {
    expect(nearestAnsi16(0, 255, 0)).toBe("92");
    expect(nearestAnsi16(255, 0, 0)).toBe("91");
  });

  it("token codes are bare SGR fg codes (30–37, 90–97)", () => {
    for (const t of TOKENS) {
      const code = fgCodes(t, "16");
      expect(code).toMatch(/^(3[0-7]|9[0-7])$/);
    }
  });
});

describe("background codes", () => {
  it("truecolor bg uses 48;2 form", () => {
    expect(bgCodes("err", "truecolor")).toBe("48;2;255;122;154");
  });

  it("bg skips the 16 rung (no reliable bg base colors)", () => {
    expect(bgCodes("err", "16")).toBe("");
  });
});

describe("session-hue consistency (docs/03 §Session hue contract)", () => {
  it("same id → same cube index every call", () => {
    for (const id of ["s-9f2c", "worker-3", "abcdef12-1234"]) {
      expect(hueIndex(id)).toBe(hueIndex(id));
      expect(hueIndex(id)).toBe(16 + sessionHue(id));
    }
  });

  it("hueIndex matches web hue math: cubeIndexToRgb(16 + hashSessionId(id) % 216)", () => {
    // web/src/hue.ts consumes cubeIndexToRgb + hashSessionId from the lib
    // barrel; this re-derives its computation from the same exports so CLI
    // and web provably agree per id.
    for (const id of ["s-9f2c", "worker-3", "tilt", "api"]) {
      const expected = 16 + (hashSessionId(id) % 216);
      expect(hueIndex(id)).toBe(expected);
      expect(hueColorCodes(id)).toBe(cubeIndexToCodes(expected));
    }
  });
});

describe("ColorLevel type surface", () => {
  it("ladder rungs are exactly truecolor → 256 → 16 → plain", () => {
    const rungs: ColorLevel[] = ["truecolor", "256", "16", "plain"];
    expect(rungs).toHaveLength(4);
  });
});
