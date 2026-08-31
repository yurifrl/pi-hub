// lib/domain/summary.test.ts — pure unit: resolution line format pinned to docs/02.
import { describe, it, expect } from "bun:test";
import { resolutionText, resolutionLine } from "./summary";

describe("resolutionText", () => {
  it("carries the answer", () => {
    expect(resolutionText("att-3", "question", "yes for v1")).toBe("resolved att-3 (question): yes for v1");
  });

  it("dismissals read 'dismissed'", () => {
    expect(resolutionText("att-6", "approval", undefined)).toBe("resolved att-6 (approval): dismissed");
  });

  it("auto-resolves read 'auto'", () => {
    expect(resolutionText("att-7", "idle", "auto")).toBe("resolved att-7 (idle): auto");
  });
});

describe("resolutionLine", () => {
  it("builds a kind:resolution SummaryLine", () => {
    expect(
      resolutionLine({
        t: "2026-08-30T18:00:00.000Z",
        sessionId: "s-9f2c",
        id: "att-6",
        kind: "approval",
        answer: "ship it",
        by: "cli",
      }),
    ).toEqual({
      t: "2026-08-30T18:00:00.000Z",
      sessionId: "s-9f2c",
      kind: "resolution",
      text: "resolved att-6 (approval): ship it",
      by: "cli",
    });
  });
});
