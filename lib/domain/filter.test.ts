// lib/domain/filter.test.ts — pure unit: Filter exercised as a table of cases
// (docs/01-architecture.md §Testing).
import { describe, it, expect } from "bun:test";
import { matchesSummary, matchesAttention, matchesSession, matchesLogEntry, type Filter } from "./filter";
import type { SummaryLine, AttentionItem, SessionRecord, LogEntry } from "./session";

const summary = (over: Partial<SummaryLine> = {}): SummaryLine => ({
  t: "2026-08-30T17:57:51.401Z",
  sessionId: "s-9f2c",
  kind: "summary",
  text: "mid-review of deploy plan",
  by: "agent",
  ...over,
});

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "att-6",
  sessionId: "s-9f2c",
  kind: "approval",
  text: "approve deploy canary 2/3",
  createdAt: "2026-08-30T17:52:19.400Z",
  ...over,
});

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  status: "open",
  kind: "peer",
  cwd: "/tmp",
  title: "review the tilt deploy plan",
  model: "m",
  phase: "waiting",
  log: "logs/s-9f2c.jsonl",
  toolCounts: {},
  turns: 1,
  startedAt: "2026-08-30T17:42:58.201Z",
  lastActivity: "2026-08-30T17:52:19.400Z",
  ...over,
});

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  t: 0,
  sessionId: "s-9f2c",
  kind: "tool_call",
  text: "bash: bun test",
  ...over,
});

describe("matchesSummary", () => {
  const cases: Array<[Filter | undefined, SummaryLine, boolean]> = [
    [undefined, summary(), true],
    [{ id: "s-9f2c" }, summary(), true],
    [{ id: "s-4a71" }, summary(), false],
    [{ text: "DEPLOY" }, summary(), true],
    [{ text: "nope" }, summary(), false],
  ];
  for (const [f, line, want] of cases) {
    it(`${JSON.stringify(f)} → ${want}`, () => {
      expect(matchesSummary(line, f)).toBe(want);
    });
  }
});

describe("matchesAttention", () => {
  const cases: Array<[Filter | undefined, AttentionItem, boolean]> = [
    [undefined, item(), true],
    [{ id: "s-9f2c" }, item(), true],
    [{ kind: ["approval"] }, item(), true],
    [{ kind: ["question", "blocked"] }, item(), false],
    [{ kind: [] }, item(), true],
    [{ text: "canary" }, item(), true],
    [{ text: "CANARY" }, item(), true],
    [{ text: "canary", id: "s-9f2c", kind: ["approval"] }, item(), true],
    [{ text: "canary", id: "s-4a71" }, item(), false],
  ];
  for (const [f, item, want] of cases) {
    it(`${JSON.stringify(f)} → ${want}`, () => {
      expect(matchesAttention(item, f)).toBe(want);
    });
  }
});

describe("matchesSession", () => {
  const cases: Array<[Filter | undefined, SessionRecord, boolean]> = [
    [undefined, session(), true],
    [{ phase: ["waiting"] }, session(), true],
    [{ phase: ["idle", "blocked"] }, session(), false],
    [{ phase: [] }, session(), true],
    [{ text: "deploy" }, session(), true],
    [{ text: "deploy", phase: ["waiting"] }, session(), true],
    [{ text: "nomatch" }, session(), false],
    [{ id: "tilt" }, session({ title: "worker tilt" }), true],
  ];
  for (const [f, s, want] of cases) {
    it(`${JSON.stringify(f)} → ${want}`, () => {
      expect(matchesSession(s, f)).toBe(want);
    });
  }
});

describe("matchesLogEntry", () => {
  const cases: Array<[Filter | undefined, LogEntry, boolean]> = [
    [undefined, entry(), true],
    [{ id: "s-9f2c" }, entry(), true],
    [{ id: "s-4a71" }, entry(), false],
    [{ text: "bun" }, entry(), true],
    [{ text: "BUN TEST" }, entry(), true],
    [{ text: "nope" }, entry(), false],
  ];
  for (const [f, e, want] of cases) {
    it(`${JSON.stringify(f)} → ${want}`, () => {
      expect(matchesLogEntry(e, f)).toBe(want);
    });
  }
});
