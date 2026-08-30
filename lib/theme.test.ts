// lib/theme.test.ts — pure unit: token table pinned to docs values, hue
// distribution and stability, cube decoding round-trip.
import { describe, it, expect } from "bun:test";
import { TOKEN_HEX, TOKEN_RGB, sessionHue, hueColorCodes, cubeIndexToCodes, tokenColorCodes, hashSessionId } from "./theme";

describe("token palette (docs/01 DRY table, docs/03 ANSI table)", () => {
  it("exact hex values", () => {
    expect(TOKEN_HEX).toEqual({
      accent: "#70e1c4",
      ok: "#3fd68f",
      warn: "#f5c04e",
      err: "#ff7a9a",
      muted: "#8b97b0",
    });
  });

  it("RGB matches truecolor codes in docs/03", () => {
    expect(TOKEN_RGB.accent).toEqual([112, 225, 196]);
    expect(TOKEN_RGB.ok).toEqual([63, 214, 143]);
    expect(TOKEN_RGB.warn).toEqual([245, 192, 78]);
    expect(TOKEN_RGB.err).toEqual([255, 122, 154]);
    expect(TOKEN_RGB.muted).toEqual([139, 151, 176]);
  });

  it("tokenColorCodes matches docs/03 truecolor column", () => {
    expect(tokenColorCodes("accent")).toBe("38;2;112;225;196");
    expect(tokenColorCodes("ok")).toBe("38;2;63;214;143");
    expect(tokenColorCodes("warn")).toBe("38;2;245;192;78");
    expect(tokenColorCodes("err")).toBe("38;2;255;122;154");
    expect(tokenColorCodes("muted")).toBe("38;2;139;151;176");
  });
});

describe("session hue", () => {
  it("lands in the 6×6×6 cube range", () => {
    for (let i = 0; i < 500; i++) {
      const h = sessionHue(`s-${i}`);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(216);
    }
  });

  it("derives only from sessionId — stable and deterministic", () => {
    expect(sessionHue("s-9f2c")).toBe(sessionHue("s-9f2c"));
    expect(sessionHue("s-9f2c")).not.toBe(sessionHue("worker-3"));
  });

  it("spreads across the cube (not clustered on a few values)", () => {
    const distinct = new Set(Array.from({ length: 200 }, (_, i) => sessionHue(`session-${i}`)));
    expect(distinct.size).toBeGreaterThan(100);
  });
});

describe("cube decoding", () => {
  it("cubeIndexToCodes follows the 6×6×6 step formula", () => {
    expect(cubeIndexToCodes(16)).toBe("38;2;0;0;0");
    expect(cubeIndexToCodes(231)).toBe("38;2;255;255;255");
  });

  it("hueColorCodes equals cubeIndexToCodes(16 + hue)", () => {
    for (const id of ["s-9f2c", "s-4a71", "s-c0de"]) {
      expect(hueColorCodes(id)).toBe(cubeIndexToCodes(16 + sessionHue(id)));
    }
  });
});

describe("hashSessionId (FNV-1a)", () => {
  it("handles multibyte ids deterministically", () => {
    expect(hashSessionId("s-9f2c")).toBe(hashSessionId("s-9f2c"));
    expect(hashSessionId("s-ünïcødé")).toBe(hashSessionId("s-ünïcødé"));
  });

  it("known vector: FNV-1a of empty input is the offset basis", () => {
    expect(hashSessionId("")).toBe(0x811c9dc5);
  });
});
