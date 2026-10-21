// cli/src/screens/watch.test.ts — the pure watch state machine (docs/03-cli.md
// §hub watch): sessions rail + chat. Fake bus events and keys in → state +
// actions out; painter checks run on plain cells (docs/01 §Testing — never
// real sockets, never sleeps).

import { describe, it, expect } from "bun:test";
import type { LogEntry, StatusFile } from "@yurifrl/hub";
import {
  initialWatchState,
  applyEvent,
  applyKey,
  ensureSelection,
  mergeEntries,
  openAttention,
  railIds,
  sessionGlyph,
  sessionName,
  type KeyAction,
  type ViewMetrics,
  type WatchState,
} from "./watch";
import { chatLines, paintWatchView } from "../render/watch_view";
import type { Key } from "../render/inputs";

const VIEW: ViewMetrics = { pageRows: 10, maxScroll: 50 };

const sess = (over: Partial<StatusFile["sessions"][string]> = {}): StatusFile["sessions"][string] => ({
  status: "open",
  kind: "worker",
  cwd: "/tmp/alpha",
  title: "test",
  model: "m",
  phase: "working",
  log: "logs/x.jsonl",
  toolCounts: {},
  turns: 0,
  startedAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  ...over,
});

const status = (over: Partial<StatusFile> = {}): StatusFile => ({
  version: 1,
  startedAt: new Date(0).toISOString(),
  pid: 1,
  nextAttentionId: 1,
  sessions: {
    "s-alpha12345678": sess(),
    "s-betaaaaaaaaaa": sess({ cwd: "/tmp/beta", phase: "idle" }),
    "s-gamma": sess({ cwd: "/tmp/gamma", phase: "waiting" }),
  },
  attention: [],
  archived: [],
  ...over,
});

const question = {
  id: "att-1",
  sessionId: "s-betaaaaaaaaaa",
  kind: "question" as const,
  text: "pin to 1.4?",
  createdAt: new Date(0).toISOString(),
};

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  t: Date.parse("2026-08-30T18:00:00.000Z"),
  sessionId: "s-alpha12345678",
  kind: "tool_call",
  text: "bun test",
  ...over,
});

const ch = (char: string): Key => ({ kind: "char", char });
const key = (kind: Exclude<Key["kind"], "char">): Key => ({ kind }) as Key;

/** Step through keys; the last action is returned alongside the folded state. */
const press = (s: WatchState, ...keys: Key[]): { state: WatchState; last: KeyAction } => {
  let state = s;
  let last: KeyAction = { type: "state", state };
  for (const k of keys) {
    last = applyKey(state, k, VIEW);
    if (last.type === "quit") break;
    state = last.state;
  }
  return { state, last };
};

const text = (rows: { ch: string }[][]): string => rows.map((r) => r.map((c) => c.ch).join("").trimEnd()).join("\n");

describe("selection", () => {
  it("opens on the first session; arrows move and clamp at the ends", () => {
    let s = initialWatchState(status());
    expect(s.selected).toBe("s-alpha12345678");
    s = press(s, key("up")).state;
    expect(s.selected).toBe("s-alpha12345678");
    s = press(s, key("down"), key("down"), key("down")).state;
    expect(s.selected).toBe("s-gamma");
  });

  it("1-9 jumps to the nth session; out of range is a no-op", () => {
    const s = initialWatchState(status());
    expect(press(s, ch("2")).state.selected).toBe("s-betaaaaaaaaaa");
    expect(press(s, ch("9")).state.selected).toBe("s-alpha12345678");
  });

  it("selection survives its session leaving the map by falling to the first", () => {
    let s = press(initialWatchState(status()), ch("3")).state;
    const { "s-gamma": _gone, ...rest } = status().sessions;
    void _gone;
    s = ensureSelection({ ...s, status: status({ sessions: rest }) });
    expect(s.selected).toBe("s-alpha12345678");
    expect(ensureSelection({ ...s, status: status({ sessions: {} }) }).selected).toBeNull();
  });

  it("no sessions: enter does not open compose", () => {
    const s = initialWatchState(null);
    expect(press(s, key("enter")).state.focus).toBe("rail");
  });

  it("q and ctrl-c quit from the rail", () => {
    const s = initialWatchState(status());
    expect(applyKey(s, ch("q"), VIEW).type).toBe("quit");
    expect(applyKey(s, key("ctrl-c"), VIEW).type).toBe("quit");
  });
});

describe("unread", () => {
  it("history on first read is never unread; live entries for another session are", () => {
    let s = initialWatchState(status());
    s = mergeEntries(s, "s-betaaaaaaaaaa", [entry({ sessionId: "s-betaaaaaaaaaa" })], false);
    expect(s.unread).toEqual({});
    s = mergeEntries(s, "s-betaaaaaaaaaa", [entry({ sessionId: "s-betaaaaaaaaaa" }), entry({ sessionId: "s-betaaaaaaaaaa", kind: "assistant_message" })], true);
    expect(s.unread["s-betaaaaaaaaaa"]).toBe(2);
  });

  it("entries for the open conversation, and your own messages, are not unread", () => {
    let s = initialWatchState(status());
    s = mergeEntries(s, "s-alpha12345678", [entry()], true);
    expect(s.unread).toEqual({});
    s = mergeEntries(s, "s-betaaaaaaaaaa", [entry({ sessionId: "s-betaaaaaaaaaa", kind: "user_message" })], true);
    expect(s.unread).toEqual({});
  });

  it("selecting a session clears its unread count", () => {
    let s = initialWatchState(status());
    s = mergeEntries(s, "s-betaaaaaaaaaa", [entry({ sessionId: "s-betaaaaaaaaaa" })], true);
    s = press(s, key("down")).state;
    expect(s.selected).toBe("s-betaaaaaaaaaa");
    expect(s.unread).toEqual({});
  });

  it("per-session history is capped", () => {
    const many = Array.from({ length: 500 }, (_, i) => entry({ text: `n${i}` }));
    const s = mergeEntries(initialWatchState(status()), "s-alpha12345678", many, false);
    const kept = s.entries["s-alpha12345678"]!;
    expect(kept).toHaveLength(400);
    expect(kept[kept.length - 1]!.text).toBe("n499");
  });
});

describe("compose", () => {
  it("⏎ opens compose; typing builds a draft; backspace edits; drafts are per session", () => {
    let s = press(initialWatchState(status()), key("enter"), ch("h"), ch("i"), ch("!"), key("backspace")).state;
    expect(s.focus).toBe("compose");
    expect(s.drafts["s-alpha12345678"]).toBe("hi");
    s = press(s, key("escape"), key("down"), key("enter"), ch("x")).state;
    expect(s.drafts["s-betaaaaaaaaaa"]).toBe("x");
    expect(s.drafts["s-alpha12345678"]).toBe("hi");
  });

  it("⏎ sends the trimmed draft to the selected session and clears it", () => {
    const { last } = press(initialWatchState(status()), key("enter"), ch(" "), ch("g"), ch("o"), ch(" "), key("enter"));
    expect(last.type).toBe("send");
    if (last.type !== "send") throw new Error("unreachable");
    expect(last.sessionId).toBe("s-alpha12345678");
    expect(last.text).toBe("go");
    expect(last.state.drafts["s-alpha12345678"]).toBe("");
    expect(last.state.focus).toBe("compose"); // stay in the conversation
  });

  it("empty draft sends nothing", () => {
    expect(press(initialWatchState(status()), key("enter"), key("enter")).last.type).toBe("state");
  });

  it("when the session has an open question, ⏎ answers that item instead of sending", () => {
    let s = initialWatchState(status({ attention: [question] }));
    s = press(s, key("down"), key("enter"), ch("y")).state;
    const last = applyKey(s, key("enter"), VIEW);
    expect(last.type).toBe("answer");
    if (last.type !== "answer") throw new Error("unreachable");
    expect(last.itemId).toBe("att-1");
    expect(last.text).toBe("y");
  });

  it("esc and tab return to the rail keeping the draft", () => {
    const s = press(initialWatchState(status()), key("enter"), ch("a"), key("tab")).state;
    expect(s.focus).toBe("rail");
    expect(s.drafts["s-alpha12345678"]).toBe("a");
  });

  it("q is text while composing, not quit", () => {
    const { state, last } = press(initialWatchState(status()), key("enter"), ch("q"));
    expect(last.type).toBe("state");
    expect(state.drafts["s-alpha12345678"]).toBe("q");
  });
});

describe("scroll and dismiss", () => {
  it("PgUp scrolls back by a page, clamped to what the view can show; PgDn returns", () => {
    let s = initialWatchState(status());
    s = press(s, key("pageup")).state;
    expect(s.scroll).toBe(10);
    s = press(s, key("pageup"), key("pageup"), key("pageup"), key("pageup"), key("pageup")).state;
    expect(s.scroll).toBe(50);
    s = press(s, key("pagedown")).state;
    expect(s.scroll).toBe(40);
  });

  it("switching session resets scroll to the bottom", () => {
    const s = press(initialWatchState(status()), key("pageup"), key("down")).state;
    expect(s.scroll).toBe(0);
  });

  it("d dismisses the selected session's open question; nothing open → no action", () => {
    const withQ = press(initialWatchState(status({ attention: [question] })), key("down")).state;
    expect(applyKey(withQ, ch("d"), VIEW).type).toBe("dismiss");
    expect(applyKey(initialWatchState(status()), ch("d"), VIEW).type).toBe("state");
  });
});

describe("applyEvent", () => {
  it("attention frames add and resolve rail items", () => {
    let s = initialWatchState(status());
    s = applyEvent(s, { topic: "attention", payload: question });
    expect(openAttention(s, "s-betaaaaaaaaaa")).toHaveLength(1);
    s = applyEvent(s, { topic: "attention", payload: { ...question, resolvedAt: new Date(1).toISOString() } });
    expect(openAttention(s, "s-betaaaaaaaaaa")).toHaveLength(0);
  });

  it("phase frames move the session symbol", () => {
    let s = initialWatchState(status());
    s = applyEvent(s, { topic: "phase", payload: { sessionId: "s-alpha12345678", phase: "idle" } });
    expect(s.status!.sessions["s-alpha12345678"]!.phase).toBe("idle");
  });

  it("log frames do not touch entries (the file tail is the single source)", () => {
    const s = initialWatchState(status());
    expect(applyEvent(s, { topic: "log", payload: entry() })).toBe(s);
  });
});

describe("symbols and names", () => {
  it("needs-you outranks phase; phases map to distinct icons", () => {
    expect(sessionGlyph(sess(), true).glyph).toBe("⚠");
    expect(sessionGlyph(sess({ phase: "working" }), false).glyph).toBe("▶");
    expect(sessionGlyph(sess({ phase: "waiting" }), false).glyph).toBe("?");
    expect(sessionGlyph(sess({ phase: "idle" }), false).glyph).toBe("○");
    expect(sessionGlyph(sess({ phase: "blocked" }), false).glyph).toBe("✖");
    expect(sessionGlyph(sess({ status: "closing" }), false).glyph).toBe("·");
  });

  it("name is the cwd basename, else the id prefix", () => {
    expect(sessionName("s-alpha12345678", sess({ cwd: "/Workdir/Yuri/home/systems" }))).toBe("systems");
    expect(sessionName("s-alpha12345678", undefined)).toBe("s-alpha1");
    expect(railIds(status())).toHaveLength(3);
  });
});

describe("painting", () => {
  const withChat = (): WatchState => {
    let s = initialWatchState(status({ attention: [question] }));
    s = mergeEntries(
      s,
      "s-alpha12345678",
      [
        entry({ kind: "user_message", text: "deploy the canary" }),
        entry({ kind: "tool_call", text: "bash ls" }),
        entry({ kind: "assistant_message", text: "done, canary is at 2/3" }),
      ],
      false,
    );
    return s;
  };

  it("rail lists every session with its symbol; the open conversation is on the right", () => {
    const out = text(paintWatchView(withChat(), 100, 24, 0).rows);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
    expect(out).toContain("⚠"); // beta has an open question
    expect(out).toContain("deploy the canary");
    expect(out).toContain("canary is at 2/3");
    expect(out).toContain("1 need you");
  });

  it("selected session's open question is pinned above the compose line", () => {
    const s = press(withChat(), key("down")).state;
    expect(text(paintWatchView(s, 100, 24, 0).rows)).toContain("pin to 1.4?");
  });

  it("unread badge shows next to the session until it is opened", () => {
    const s = mergeEntries(withChat(), "s-gamma", [entry({ sessionId: "s-gamma" })], true);
    expect(text(paintWatchView(s, 100, 24, 0).rows)).toContain("+1");
  });

  it("compose focus shows the draft with a cursor; offline is flagged", () => {
    let s = press(withChat(), key("enter"), ch("h"), ch("i")).state;
    s = { ...s, offline: true };
    const out = text(paintWatchView(s, 100, 24, 0).rows);
    expect(out).toContain("› hi█");
    expect(out).toContain("hub offline");
  });

  it("every row fits the terminal width and the frame fits its height", () => {
    const { rows } = paintWatchView(withChat(), 60, 20, 0);
    expect(rows.length).toBeLessThanOrEqual(20);
    for (const r of rows) expect(r.length).toBe(60);
  });

  it("view metrics report how far the conversation can scroll", () => {
    const many = Array.from({ length: 80 }, (_, i) => entry({ kind: "assistant_message", text: `line ${i}` }));
    const s = mergeEntries(initialWatchState(status()), "s-alpha12345678", many, false);
    expect(paintWatchView(s, 100, 24, 0).view.maxScroll).toBeGreaterThan(0);
    expect(paintWatchView(initialWatchState(status()), 100, 24, 0).view.maxScroll).toBe(0);
  });
});

describe("chatLines tool/system rows", () => {
  const flat = (cells: { ch: string }[][]): string[] => cells.map((r) => r.map((c) => c.ch).join(""));

  it("tool calls collapse to one ellipsized line showing the telling arg, not raw JSON", () => {
    const long = "x".repeat(200);
    const lines = flat(
      chatLines(
        [entry({ text: `bash ${JSON.stringify({ command: long, other: 1 })}` }), entry({ text: 'todo {"op":"done"}' }), entry({ text: "read {}" })],
        "alpha",
        0,
        40,
      ),
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith("  ▶ bash xxx");
    expect(lines[0]!.endsWith("…")).toBe(true);
    expect(lines[0]!.length).toBeLessThanOrEqual(40);
    expect(lines[1]).toBe("  ▶ todo done");
    expect(lines[2]).toBe("  ▶ read");
  });

  it("empty system rows are dropped", () => {
    const lines = flat(chatLines([entry({ kind: "session_start", text: "  " }), entry({ kind: "agent_end", text: "" })], "alpha", 0, 40));
    expect(lines).toHaveLength(0);
  });
});
