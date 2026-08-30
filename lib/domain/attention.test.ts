// lib/domain/attention.test.ts — pure unit: proposeAttention as a table of cases
// with a frozen Clock (docs/01-architecture.md §Testing).
import { describe, it, expect } from "bun:test";
import { proposeAttention } from "./attention";
import type { LogEntry } from "./session";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  t: 1_000_000,
  sessionId: "s-9f2c",
  kind: "assistant_message",
  text: "hello",
  ...over,
});

const NOW = 1_000_000;

describe("proposeAttention — approval", () => {
  const texts = [
    "approve deploy canary 2/3 for tilt",
    "permission request: run bash command",
    "confirm the 200 GB disk wipe",
  ];
  for (const text of texts) {
    it(`"${text}" → approval`, () => {
      const c = proposeAttention(entry({ kind: "tool_call", text }), { now: NOW });
      expect(c).not.toBeNull();
      expect(c!.kind).toBe("approval");
      expect(c!.sessionId).toBe("s-9f2c");
      expect(c!.evidence).toHaveLength(1);
    });
  }
});

describe("proposeAttention — question", () => {
  const texts = ["which branch should I target?", "do you want me to open a PR?"];
  for (const text of texts) {
    it(`"${text}" → question`, () => {
      const c = proposeAttention(entry({ text }), { now: NOW });
      expect(c).not.toBeNull();
      expect(c!.kind).toBe("question");
    });
  }
});

describe("proposeAttention — blocked", () => {
  const texts = [
    "missing credential for deploy",
    "ECONNREFUSED 127.0.0.1:5432",
    "repeated tool failure: edit 3x",
  ];
  for (const text of texts) {
    it(`"${text}" → blocked`, () => {
      const c = proposeAttention(entry({ kind: "tool_call", text }), { now: NOW });
      expect(c).not.toBeNull();
      expect(c!.kind).toBe("blocked");
    });
  }
});

describe("proposeAttention — idle", () => {
  it("fires only past the idle timeout", () => {
    const lastActivityAt = NOW - 30 * 60 * 1000;
    const under = proposeAttention(entry({ text: "nothing happening" }), {
      now: NOW,
      idleTimeoutMs: 31 * 60 * 1000,
      lastActivityAt,
    });
    expect(under).toBeNull();

    const past = proposeAttention(entry({ text: "nothing happening" }), {
      now: NOW,
      idleTimeoutMs: 30 * 60 * 1000,
      lastActivityAt: NOW - 30 * 60 * 1000,
    });
    expect(past).not.toBeNull();
    expect(past!.kind).toBe("idle");
  });

  it("not evaluated when timeout or last activity missing", () => {
    expect(proposeAttention(entry(), { now: NOW, idleTimeoutMs: 1 })).toBeNull();
    expect(proposeAttention(entry(), { now: NOW, lastActivityAt: 0 })).toBeNull();
  });
});

describe("proposeAttention — no item raised", () => {
  const cases: LogEntry[] = [
    entry({ text: "refactored the store and updated tests" }),
    entry({ kind: "session_start", text: "session began" }),
    entry({ kind: "agent_end", text: "done" }),
    entry({ text: "" }),
  ];
  for (const e of cases) {
    it(`kind=${e.kind} text="${e.text.slice(0, 30)}" → null`, () => {
      expect(proposeAttention(e, { now: NOW })).toBeNull();
    });
  }
});

describe("proposeAttention — priority", () => {
  it("approval beats question when both match", () => {
    const c = proposeAttention(entry({ kind: "tool_call", text: "approve? is that ok?" }), { now: NOW });
    expect(c!.kind).toBe("approval");
  });
});
