// lib/domain/attention.test.ts — pure unit: proposeAttention as a table of cases
// with a frozen Clock (docs/01-architecture.md §Testing).
import { describe, it, expect } from "bun:test";
import { proposeAttention, detectApproval, detectQuestion, detectBlocked } from "./attention";
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

// ---- rubric tests (tk-d6u): negatives, cause-key stability, determinism ----

describe("proposeAttention — negative cases (a false alarm is worse than a late item)", () => {
  it("approval-shaped text is not a question (approval wins, never re-raised as question)", () => {
    const c = proposeAttention(entry({ kind: "tool_call", text: "confirm the 200 GB disk wipe" }), { now: NOW });
    expect(c!.kind).toBe("approval");
  });

  it("an assistant statement ending in a period is not a question", () => {
    expect(proposeAttention(entry({ text: "deploy finished. let me know if you want details." }), { now: NOW })).toBeNull();
  });

  it("a question the session answered itself is not raised (docs/06 counter-example)", () => {
    expect(proposeAttention(entry({ text: "which branch? the default one, main." }), { now: NOW })).toBeNull();
  });

  it("routine tool output is not blocked (docs/06 counter-example)", () => {
    expect(proposeAttention(entry({ kind: "tool_call", text: "3 files edited, tests green" }), { now: NOW })).toBeNull();
  });

  it("an approval suggestion in narration is not raised (assistant narration, no prompt)", () => {
    expect(proposeAttention(entry({ text: "approved? not yet — I will ask once the build is green." }), { now: NOW })).toBeNull();
  });

  it("word endings do not trigger approval (grounded token match)", () => {
    expect(proposeAttention(entry({ kind: "tool_call", text: "the file was approved, continuing" }), { now: NOW })).toBeNull();
  });

  it("a recoverable retry is not blocked (docs/06 counter-example)", () => {
    expect(proposeAttention(entry({ kind: "tool_call", text: "retry 1 of 3: flaky network" }), { now: NOW })).toBeNull();
  });

  it("a resolved (proceeding) tool call raises nothing", () => {
    expect(proposeAttention(entry({ kind: "tool_call", text: "kubectl rollout status — done" }), { now: NOW })).toBeNull();
  });

  it("idempotent resolution: same cause kind on a later event keeps one episode", () => {
    const first = proposeAttention(entry({ kind: "tool_call", text: "permission request: deploy canary", t: 1 }), { now: NOW });
    const again = proposeAttention(entry({ kind: "tool_call", text: "permission request: deploy canary", t: 2 }), { now: NOW });
    expect(first!.cause).toBe(again!.cause);
  });
});

describe("proposeAttention — cause-key stability (store dedupes on it)", () => {
  it("same approval shape → same cause across events", () => {
    const a = proposeAttention(entry({ kind: "tool_call", text: "permission request: run tests", t: 1 }), { now: NOW });
    const b = proposeAttention(entry({ kind: "tool_call", text: "permission request: run tests", t: 999 }), { now: NOW });
    expect(a!.cause).toBe(b!.cause);
    expect(a!.cause).toMatch(/^approval:/);
  });

  it("same question text → same cause; different text → different cause", () => {
    const q = (text: string) => proposeAttention(entry({ text }), { now: NOW })!;
    const a = q("which region should I deploy to?");
    const b = q("which region should I deploy to?");
    const c = q("which database should I use?");
    expect(a.cause).toBe(b.cause);
    expect(a.cause).not.toBe(c.cause);
    expect(a.cause).toMatch(/^question:s-9f2c:[0-9a-f]{8}$/);
  });

  it("blocked cause is stable per tool within an episode", () => {
    const a = proposeAttention(entry({ kind: "tool_call", text: "fatal: cannot connect to registry", t: 1 }), { now: NOW });
    const b = proposeAttention(entry({ kind: "tool_call", text: "fatal: cannot connect to registry", t: 2 }), { now: NOW });
    expect(a!.cause).toBe(b!.cause);
    expect(a!.cause).toMatch(/^blocked:/);
  });

  it("idle cause is keyed by session only", () => {
    const a = proposeAttention(entry({ text: "still quiet" }), { now: NOW, idleTimeoutMs: 60_000, lastActivityAt: NOW - 120_000 })!;
    const b = proposeAttention(entry({ text: "still quiet" }), { now: NOW + 60_000, idleTimeoutMs: 60_000, lastActivityAt: NOW - 180_000 })!;
    expect(a.cause).toBe(b.cause);
    expect(a.cause).toBe("idle:s-9f2c");
  });
});

describe("proposeAttention — determinism (debounce-friendly pure function)", () => {
  it("same entry + same ctx → deep-equal candidate (no hidden state)", () => {
    const e = entry({ kind: "tool_call", text: "permission request: edit keymap.c" });
    const a = proposeAttention(e, { now: NOW });
    const b = proposeAttention(e, { now: NOW });
    expect(a).toEqual(b);
  });

  it("same entry + same ctx → deep-equal idle candidate", () => {
    const e = entry({ text: "nothing happening" });
    const ctx = { now: NOW, idleTimeoutMs: 30 * 60 * 1000, lastActivityAt: NOW - 45 * 60 * 1000 };
    expect(proposeAttention(e, ctx)).toEqual(proposeAttention(e, ctx));
  });
});

describe("proposeAttention — idle text shape (docs/06: idle <N>m + last activity)", () => {
  it("text = 'idle <N>m' + last activity summary", () => {
    const c = proposeAttention(entry({ text: "wrote the data-contract draft" }), {
      now: NOW,
      idleTimeoutMs: 15 * 60 * 1000,
      lastActivityAt: NOW - 32 * 60 * 1000,
    })!;
    expect(c.kind).toBe("idle");
    expect(c.text).toContain("idle 32m");
    expect(c.text).toContain("wrote the data-contract draft");
  });

  it("clamps sub-minute idle to 1m (tiny injectable threshold)", () => {
    const c = proposeAttention(entry({ text: "quiet" }), {
      now: NOW,
      idleTimeoutMs: 20_000,
      lastActivityAt: NOW - 25_000,
    })!;
    expect(c.text).toContain("idle 1m");
  });

  it("falls back to 'no recent activity' when the last entry has no text", () => {
    const c = proposeAttention(entry({ text: "" }), {
      now: NOW,
      idleTimeoutMs: 15 * 60 * 1000,
      lastActivityAt: NOW - 20 * 60 * 1000,
    });
    expect(c).not.toBeNull();
    expect(c!.text).toContain("no recent activity");
  });

  it("caps question and blocked text at 160 chars (docs/06: ≤ 160)", () => {
    const long = "x".repeat(400);
    const q = proposeAttention(entry({ text: `should we ${long}?` }), { now: NOW })!;
    expect(q.text.length).toBeLessThanOrEqual(160);
    const b = proposeAttention(entry({ kind: "tool_call", text: `fatal: ${long}` }), { now: NOW })!;
    expect(b.text.length).toBeLessThanOrEqual(160);
  });
});

describe("proposeAttention — detection rules exported (composition transparency)", () => {
  it("detectQuestion fires on the i18n-light explicit marker", () => {
    const d = detectQuestion(entry({ text: "question: which output format do you prefer — json or ndjson?" }));
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("question");
  });

  it("detectQuestion fires on the CJK fullwidth question mark and 吗 particle", () => {
    expect(detectQuestion(entry({ text: "どちらのブランチをtargetしますか？" }))).not.toBeNull();
    expect(detectQuestion(entry({ text: "要继续吗" }))).not.toBeNull();
  });

  it("detectQuestion does not fire on terminal-free statements", () => {
    expect(detectQuestion(entry({ text: "deploy finished" }))).toBeNull();
  });

  it("detectBlocked fires on a tool_call with a danger keyword (risky tool output)", () => {
    const d = detectBlocked(entry({ kind: "tool_call", text: "panic: runtime index out of range" }));
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("blocked");
    expect(d!.meta?.error).toBe("panic: runtime index out of range");
  });

  it("detectBlocked does not fire on assistant narration mentioning 'error'", () => {
    expect(detectBlocked(entry({ kind: "assistant_message", text: "I will fix the error next" }))).toBeNull();
  });

  it("detectApproval fires on a permission-prompt prefix without tool meta", () => {
    const d = detectApproval(entry({ text: "permission request: run bash command" }));
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("approval");
  });
});
