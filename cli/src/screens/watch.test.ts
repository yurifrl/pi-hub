// cli/src/screens/watch.test.ts — the pure watch state machine (docs/03-cli.md
// §hub watch): fake bus events in (docs/01 §Testing capture-style — never real
// sockets, never sleeps), keys in → state + action plan out.

import { describe, it, expect } from "bun:test";
import type { LogEntry, StatusFile } from "@yurifrl/hub";
import {
  initialWatchState,
  applyEvent,
  applyKey,
  startFirstAnswer,
  moveRailFocus,
  dismissFocused,
  paneLines,
  railLines,
  openSessionIds,
  type WatchState,
} from "./watch";
import type { FeedEvent } from "../hub_events";

const status = (over: Partial<StatusFile> = {}): StatusFile => ({
  version: 1,
  startedAt: new Date(0).toISOString(),
  pid: 1,
  nextAttentionId: 1,
  sessions: {
    "s-alpha12345678": sess(),
    "s-betaaaaaaaaaa": sess(),
  },
  attention: [
    { id: "att-1", sessionId: "s-alpha12345678", kind: "approval", text: "approve deploy", createdAt: new Date(0).toISOString() },
  ],
  archived: [],
  ...over,
});

const sess = (over: Partial<StatusFile["sessions"][string]> = {}): StatusFile["sessions"][string] => ({
  status: "open",
  kind: "worker",
  cwd: "/tmp",
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

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  t: 1000,
  sessionId: "s-alpha12345678",
  kind: "tool_call",
  text: "bun test",
  ...over,
});

const ev = (topic: FeedEvent["topic"], payload: Record<string, unknown>): FeedEvent => ({ topic, payload });

// ---- applyEvent: fake bus frames feed the split ------------------------------

describe("applyEvent — fake bus frames paint the split", () => {
  it("log event appends to the pane (bottom rail material)", () => {
    let s = initialWatchState(status());
    s = applyEvent(s, ev("log", { t: 5000, sessionId: "s-alpha12345678", kind: "assistant_message", text: "hi" }));
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.text).toBe("hi");
    // pane paints it with hue bar
    const lines = paneLines(s, () => 20);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.hueSessionId).toBe("s-alpha12345678");
  });

  it("attention event patches the rail (resolvedAt removes)", () => {
    let s = initialWatchState(status());
    const resolved = { ...s.status!.attention[0]!, resolvedAt: new Date(1).toISOString(), answer: "yes" };
    s = applyEvent(s, ev("attention", resolved as unknown as Record<string, unknown>));
    expect(s.status!.attention).toHaveLength(0);

    const raised = { id: "att-2", sessionId: "s-betaaaaaaaaaa", kind: "question", text: "pin?", createdAt: new Date(2).toISOString() };
    s = applyEvent(s, ev("attention", raised as unknown as Record<string, unknown>));
    expect(s.status!.attention.map((a) => a.id)).toEqual(["att-2"]);
  });

  it("phase event flips the session record in place", () => {
    let s = initialWatchState(status());
    s = applyEvent(s, ev("phase", { sessionId: "s-betaaaaaaaaaa", phase: "idle", at: new Date(0).toISOString() }));
    expect(s.status!.sessions["s-betaaaaaaaaaa"]!.phase).toBe("idle");
  });

  it("log event buffer caps at 500 entries (tail semantics)", () => {
    let s = initialWatchState(status());
    for (let i = 0; i < 600; i++) {
      s = applyEvent(s, ev("log", { t: i, sessionId: "s-a", kind: "tool_call", text: `e${i}` }));
    }
    expect(s.entries).toHaveLength(500);
    expect(s.entries[0]!.text).toBe("e100");
  });
});

// ---- keys: q exit 0 path, / filter, 1-9 pin, l/a modes ----------------------

describe("applyKey — mode/pin/filter keys (docs/03 §hub watch)", () => {
  it("q quits (exit 0 path)", () => {
    const s = initialWatchState(status());
    expect(applyKey(s, { kind: "char", char: "q" }, 2).type).toBe("quit");
    expect(applyKey(s, { kind: "ctrl-c" }, 2).type).toBe("quit");
  });

  it("/ opens the filter prompt; typing feeds it; esc clears; ⏎ closes", () => {
    let s = (applyKey(initialWatchState(status()), { kind: "char", char: "/" }, 2) as { state: WatchState }).state;
    expect(s.filterOpen).toBe(true);
    s = (applyKey(s, { kind: "char", char: "c" }, 2) as { state: WatchState }).state;
    s = (applyKey(s, { kind: "char", char: "a" }, 2) as { state: WatchState }).state;
    s = (applyKey(s, { kind: "char", char: "r" }, 2) as { state: WatchState }).state;
    s = (applyKey(s, { kind: "char", char: "g" }, 2) as { state: WatchState }).state;
    s = (applyKey(s, { kind: "char", char: "o" }, 2) as { state: WatchState }).state;
    expect(s.filter).toBe("cargo");
    // filter narrows the pane (substring across entry text)
    const filtered = paneLines({ ...s, entries: [entry({ text: "bun test" }), entry({ text: "cargo build" }), entry({ text: "bun run build" })] }, () => 20);
    expect(filtered).toHaveLength(1);
    s = (applyKey(s, { kind: "escape" }, 2) as { state: WatchState }).state;
    expect(s.filterOpen).toBe(false);
    expect(s.filter).toBe("");
  });

  it("1-9 pin the nth open session; pin again unpins", () => {
    let s = initialWatchState(status());
    s = (applyKey(s, { kind: "char", char: "2" }, 2) as { state: WatchState }).state;
    expect(s.pin).toBe("s-betaaaaaaaaaa");
    // pane shows only the pinned session
    const lines = paneLines({ ...s, entries: [entry({ sessionId: "s-alpha12345678" }), entry({ sessionId: "s-betaaaaaaaaaa" })] }, () => 20);
    expect(lines.every((l) => l.hueSessionId === "s-betaaaaaaaaaa")).toBe(true);
    s = (applyKey(s, { kind: "char", char: "2" }, 2) as { state: WatchState }).state;
    expect(s.pin).toBeNull();
  });

  it("out-of-range pin digit is a no-op", () => {
    const s = initialWatchState(status());
    const next = (applyKey(s, { kind: "char", char: "5" }, 2) as { state: WatchState }).state;
    expect(next.pin).toBeNull();
  });

  it("l toggles log-only, a toggles attention-only", () => {
    let s = initialWatchState(status());
    s = (applyKey(s, { kind: "char", char: "l" }, 2) as { state: WatchState }).state;
    expect(s.mode).toBe("log-only");
    s = (applyKey(s, { kind: "char", char: "l" }, 2) as { state: WatchState }).state;
    expect(s.mode).toBe("split");
    s = (applyKey(s, { kind: "char", char: "a" }, 2) as { state: WatchState }).state;
    expect(s.mode).toBe("attention-only");
  });

  it("q inside the filter prompt does NOT quit — prompt owns keys", () => {
    let s = (applyKey(initialWatchState(status()), { kind: "char", char: "/" }, 2) as { state: WatchState }).state;
    const action = applyKey(s, { kind: "char", char: "q" }, 2);
    expect(action.type).toBe("state");
    expect((action as { state: WatchState }).state.filter).toBe("q");
  });
});

// ---- attention rail inline model ---------------------------------------------

describe("applyKey — attention inline answer flow", () => {
  it("a opens the first item's input; typing + ⏎ emits answer with committed text", () => {
    let s = initialWatchState(status());
    s = startFirstAnswer(s);
    expect(s.focus.slot).toEqual({ type: "attention", index: 0 });
    expect(s.focus.input).toBe("");
    for (const ch of "yes") s = (applyKey(s, { kind: "char", char: ch }, 2) as { state: WatchState }).state;
    expect(s.focus.input).toBe("yes");
    const action = applyKey(s, { kind: "enter" }, 2);
    expect(action.type).toBe("answer");
    const a = action as Extract<typeof action, { type: "answer" }> & { state: WatchState };
    expect(a.itemId).toBe("att-1");
    expect(a.text).toBe("yes");
    expect(a.state.focus.input).toBeNull();
    expect(a.state.focus.drafts.get("att-1")).toBe("yes"); // per-session history
  });

  it("esc cancels the open input", () => {
    let s = startFirstAnswer(initialWatchState(status()));
    s = (applyKey(s, { kind: "char", char: "x" }, 2) as { state: WatchState }).state;
    s = (applyKey(s, { kind: "escape" }, 2) as { state: WatchState }).state;
    expect(s.focus.input).toBeNull();
    expect(s.focus.drafts.size).toBe(0);
  });

  it("⌫ deletes before the cursor", () => {
    let s = startFirstAnswer(initialWatchState(status()));
    s = (applyKey(s, { kind: "char", char: "a" }, 2) as { state: WatchState }).state;
    s = (applyKey(s, { kind: "char", char: "b" }, 2) as { state: WatchState }).state;
    s = (applyKey(s, { kind: "backspace" }, 2) as { state: WatchState }).state;
    expect(s.focus.input).toBe("a");
  });

  it("d dismisses the focused item through cmd attention dismiss", () => {
    const focused = { ...initialWatchState(status()), focus: { slot: { type: "attention", index: 0 } as const, drafts: new Map<string, string>(), input: null } };
    void focused;
    const s = moveRailFocus(initialWatchState(status()), 1);
    const action = dismissFocused(s);
    expect(action.type).toBe("dismiss");
    expect((action as { itemId: string }).itemId).toBe("att-1");
  });

  it("moveRailFocus walks the rail via the board focus model", () => {
    const two = status({
      attention: [
        { id: "att-1", sessionId: "s-alpha12345678", kind: "approval", text: "a", createdAt: new Date(0).toISOString() },
        { id: "att-2", sessionId: "s-betaaaaaaaaaa", kind: "question", text: "b", createdAt: new Date(0).toISOString() },
      ],
    });
    let s = initialWatchState(two);
    s = moveRailFocus(s, 1);
    expect(s.focus.slot).toEqual({ type: "attention", index: 0 });
    s = moveRailFocus(s, 1);
    expect(s.focus.slot).toEqual({ type: "attention", index: 1 });
    s = moveRailFocus(s, -1);
    expect(s.focus.slot).toEqual({ type: "attention", index: 0 });
  });
});

// ---- painting: split layout from a fake bus ---------------------------------

describe("painting — split layout", () => {
  it("rail paints attention top (board painter), pane paints hue-tagged log bottom", () => {
    let s = initialWatchState(status());
    s = applyEvent(s, ev("log", { t: 5000, sessionId: "s-betaaaaaaaaaa", kind: "tool_call", text: "bun run build" }));
    const rail = railLines(s, 100, 5000);
    expect(rail.length).toBeGreaterThan(0);
    expect(rail.some((l) => l.text.includes("NEEDS YOU"))).toBe(true);
    expect(rail.some((l) => l.text.includes("approve deploy"))).toBe(true);
    const pane = paneLines(s, () => 20);
    expect(pane[0]!.segs[0]![0]).toBe("▎▎ ");
  });

  it("offline renders (hub offline) muted at the rail top — a rendered state, not an exit", () => {
    const s = { ...initialWatchState(status()), offline: true };
    const rail = railLines(s, 100, 5000);
    expect(rail[0]!.text).toBe("(hub offline)");
  });

  it("header/footer material: openSessionIds feed the 1-9 pin range", () => {
    expect(openSessionIds(status())).toEqual(["s-alpha12345678", "s-betaaaaaaaaaa"]);
    const closing = status({
      sessions: { "s-x": sess({ status: "closing" }), "s-y": sess() },
    });
    expect(openSessionIds(closing)).toEqual(["s-y"]);
  });
});
