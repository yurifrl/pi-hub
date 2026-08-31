// lib/domain/describe.test.ts — pure unit: classifyBatch + idleSessions as
// tables of cases with a frozen Clock value (docs/01-architecture.md §Testing).
import { describe, it, expect } from "bun:test";
import { classifyBatch, idleSessions } from "./describe";
import type { LogEntry } from "./session";

const entry = (over: Partial<LogEntry>): LogEntry => ({
  t: 1_000,
  sessionId: "s-1",
  kind: "assistant_message",
  text: "refactoring the parser",
  ...over,
});

describe("classifyBatch", () => {
  it("defaults a session with no recorded state to working", () => {
    const out = classifyBatch([entry({ kind: "assistant_message", text: "reading files" })]);
    expect(out["s-1"]).toEqual({
      sessionId: "s-1",
      phase: "working",
      description: "reading files",
    });
  });

  it("approval-shaped tool_call → waiting with awaiting-approval description", () => {
    const out = classifyBatch([
      entry({ kind: "tool_call", text: "permission request: run bash command" }),
    ]);
    expect(out["s-1"]!.phase).toBe("waiting");
    expect(out["s-1"]!.description).toContain("awaiting approval");
  });

  it("question-shaped assistant_message → waiting", () => {
    const out = classifyBatch([entry({ text: "which branch should I target?" })]);
    expect(out["s-1"]!.phase).toBe("waiting");
    expect(out["s-1"]!.description).toContain("asked you");
  });

  it("blocked-shaped assistant_message → blocked", () => {
    const out = classifyBatch([entry({ text: "fatal: repository not found" })]);
    expect(out["s-1"]!.phase).toBe("blocked");
    expect(out["s-1"]!.description).toContain("hit failure");
  });

  it("user_message clears waiting and blocked (reply = resolution signal)", () => {
    const waiting = classifyBatch([entry({ kind: "tool_call", text: "please confirm the wipe" })]);
    expect(waiting["s-1"]!.phase).toBe("waiting");

    const cleared = classifyBatch(
      [entry({ kind: "user_message", text: "yes, go ahead" })],
      { "s-1": { phase: waiting["s-1"]!.phase, lastActivityAt: 900 } },
    );
    expect(cleared["s-1"]!.phase).toBe("working");
  });

  it("agent_end ends the turn → idle, awaiting next task", () => {
    const out = classifyBatch([entry({ kind: "agent_end", text: "done" })]);
    expect(out["s-1"]!.phase).toBe("idle");
    expect(out["s-1"]!.description).toBe("turn complete; awaiting next task");
  });

  it("last meaningful event wins inside one batch", () => {
    const out = classifyBatch([
      entry({ kind: "tool_call", text: "permission request: edit file" }),
      entry({ kind: "user_message", text: "approved, continue" }),
    ]);
    expect(out["s-1"]!.phase).toBe("working");
  });

  it("descriptions are capped at 12 words", () => {
    const out = classifyBatch([
      entry({
        kind: "assistant_message",
        text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
      }),
    ]);
    const words = out["s-1"]!.description.split(" ").length;
    expect(words).toBeLessThanOrEqual(12);
  });
});

describe("idleSessions", () => {
  it("flips working sessions quiet past the timeout", () => {
    const out = idleSessions(
      new Set(),
      { "s-1": { phase: "working", lastActivityAt: 0 } },
      { now: 10_000, idleTimeoutMs: 5_000 },
    );
    expect(out).toEqual(["s-1"]);
  });

  it("never flips batch sessions (an event is activity)", () => {
    const out = idleSessions(
      new Set(["s-1"]),
      { "s-1": { phase: "working", lastActivityAt: 0 } },
      { now: 10_000, idleTimeoutMs: 5_000 },
    );
    expect(out).toEqual([]);
  });

  it("does not re-raise already-idle sessions (once per idle episode)", () => {
    const out = idleSessions(
      new Set(),
      { "s-1": { phase: "idle", lastActivityAt: 0 } },
      { now: 10_000, idleTimeoutMs: 5_000 },
    );
    expect(out).toEqual([]);
  });

  it("keeps waiting/blocked sessions out (they have an open item queued)", () => {
    const out = idleSessions(
      new Set(),
      {
        "s-w": { phase: "waiting", lastActivityAt: 0 },
        "s-b": { phase: "blocked", lastActivityAt: 0 },
      },
      { now: 10_000, idleTimeoutMs: 5_000 },
    );
    expect(out).toEqual([]);
  });
});
