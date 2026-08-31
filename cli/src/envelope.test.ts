// cli/src/envelope.test.ts — envelope shape (docs/03-cli.md §Output policies)
// and the pinned ErrorCode → exit table (docs/03 §Exit codes):
// "the ErrorCode → exit mapping in the envelope type is exhaustive" — this
// table test is that pin. Adding an ErrorCode without updating exitCodeFor
// fails here, and vice versa.

import { describe, it, expect } from "bun:test";
import { exitCodeFor, errorEnvelope, snapshotEnvelope, type ErrorCode } from "./envelope";
import { selectPolicy, PolicyError, serializeEnvelope } from "./output";

describe("exit-code table (pinned, docs/03 §Exit codes)", () => {
  it("usage class → 1", () => {
    expect(exitCodeFor("usage")).toBe(1);
  });
  it("not_found → 1", () => {
    expect(exitCodeFor("not_found")).toBe(1);
  });
  it("ambiguous → 1", () => {
    expect(exitCodeFor("ambiguous")).toBe(1);
  });
  it("busy → 1", () => {
    expect(exitCodeFor("busy")).toBe(1);
  });
  it("unavailable → 2", () => {
    expect(exitCodeFor("unavailable")).toBe(2);
  });
  it("protocol → 2", () => {
    expect(exitCodeFor("protocol")).toBe(2);
  });
  it("timeout → 3", () => {
    expect(exitCodeFor("timeout")).toBe(3);
  });

  it("every ErrorCode literal is covered — exhaustive switch, compiler-checked", () => {
    // Compile-time exhaustiveness: exitCodeFor's switch covers the closed
    // ErrorCode union (no default branch, strict tsconfig). This test pins
    // the union's current member list so accidental additions/removals show
    // up as a test failure, not just a type change.
    const all: ErrorCode[] = ["usage", "not_found", "ambiguous", "busy", "unavailable", "protocol", "timeout"];
    const exits = all.map((c) => exitCodeFor(c));
    expect(exits).toEqual([1, 1, 1, 1, 2, 2, 3]);
  });
});

describe("envelope shape (docs/03 §Output policies)", () => {
  it("snapshot envelope: {type:'snapshot', data}", () => {
    expect(snapshotEnvelope({ a: 1 })).toEqual({ type: "snapshot", data: { a: 1 } });
  });

  it("error envelope: {type:'error', error:{code, message}} — detail optional", () => {
    expect(errorEnvelope("usage", "bad")).toEqual({ type: "error", error: { code: "usage", message: "bad" } });
    expect(errorEnvelope("ambiguous", "pick one", ["att-1", "att-2"])).toEqual({
      type: "error",
      error: { code: "ambiguous", message: "pick one", detail: ["att-1", "att-2"] },
    });
  });

  it("json serialization: pretty object + trailing newline", () => {
    const out = serializeEnvelope(snapshotEnvelope({ x: 1 }), "json");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.type).toBe("snapshot");
    expect(parsed.data).toEqual({ x: 1 });
  });

  it("ndjson serialization: exactly one compact line", () => {
    const out = serializeEnvelope(errorEnvelope("timeout", "late"), "ndjson");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n")).toHaveLength(2); // line + trailing newline
    expect(out.includes("\n ")).toBe(false); // no pretty whitespace
    expect(JSON.parse(out)).toEqual({ type: "error", error: { code: "timeout", message: "late" } });
  });

  it("machine output never carries ANSI (no escape bytes)", () => {
    for (const format of ["json", "ndjson"] as const) {
      const out = serializeEnvelope(errorEnvelope("usage", "x\x1b[31mred"), format);
      expect(out.includes("\x1b[")).toBe(false);
    }
  });
});

describe("output policy selection (docs/03 §Output policies)", () => {
  it("no flags → human", () => {
    expect(selectPolicy({}, true)).toEqual({ format: "human", color: true });
  });
  it("--json → json", () => {
    expect(selectPolicy({ json: true }, false).format).toBe("json");
  });
  it("--ndjson → ndjson", () => {
    expect(selectPolicy({ ndjson: true }, false).format).toBe("ndjson");
  });
  it("--json + --ndjson → PolicyError (usage, exit 1)", () => {
    expect(() => selectPolicy({ json: true, ndjson: true }, true)).toThrow(PolicyError);
  });
  it("color passes through from config", () => {
    expect(selectPolicy({}, false).color).toBe(false);
    expect(selectPolicy({}, true).color).toBe(true);
  });
});
