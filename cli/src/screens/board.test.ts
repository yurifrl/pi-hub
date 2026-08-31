// cli/src/screens/board.test.ts — bare `hub` board screen (docs/03-cli.md
// §hub (bare)): painter layout from fake snapshot data (orientation, NEEDS
// YOU, RUNNING, IDLE, calm variant, piped inputs hidden), state-machine key
// matrix (focus/typing/⏎ → answer/assign/dismiss effects), driver effects as
// cmd frames against a stub command surface, machine-mode snapshot envelope,
// and piped-stdout degrade.

import { describe, it, expect } from "bun:test";
import type { AttentionItem, SessionRecord } from "@yurifrl/hub";
import { boardLines, paintBoard, isCalm, FOOTER_FULL, FOOTER_CALM, FOOTER_PIPED, moveFocus, type BoardModel } from "../render/board";
import { applyKey, initialBoardState, normalizeSnapshot, type BoardState, type BoardSnapshot } from "./board_state";
import { boardMachineData } from "./board";
import type { Key } from "../render/inputs";

// ---- fixtures --------------------------------------------------------------

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

const session = (over: Record<string, unknown> = {}): SessionRecord => ({
  status: "open",
  kind: "worker",
  cwd: "/tmp",
  title: "default title",
  model: "m",
  phase: "working",
  log: "logs/x.jsonl",
  toolCounts: {},
  turns: 0,
  startedAt: "2026-08-31T10:00:00.000Z",
  lastActivity: "2026-08-31T11:58:00.000Z", // 2m before NOW
  ...over,
}) as SessionRecord;

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "att-1",
  sessionId: "s-alpha12345678",
  kind: "approval",
  text: "approve deploy canary 2/3?",
  createdAt: "2026-08-31T11:50:00.000Z",
  ...over,
});

const sessions: Record<string, SessionRecord> = {
  "s-alpha12345678": session({ name: "alpha", description: "editing deploy/canary.sh" }),
  "s-betaaaaaaaaaa": session({ name: "beta", phase: "waiting", description: "asked a question" }),
  "s-gammaaaaaaaaa": session({ phase: "idle", title: "api idle", name: "gamma" }),
};

const attention: AttentionItem[] = [
  item({ id: "att-1", kind: "approval", sessionId: "s-alpha12345678", text: "approve deploy canary 2/3?" }),
  item({ id: "att-2", kind: "question", sessionId: "s-betaaaaaaaaaa", text: "pin hub to 1.4 or latest?", createdAt: "2026-08-31T11:55:00.000Z" }),
];

const reply = (over: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  sessions,
  attention,
  hub: { digest: "tilt needs approval before canary 2/3", agentSession: "s-agent000000" },
  ...over,
});

/** Model with fixed `now` for deterministic ages (2m). */
const model = (over: Partial<BoardModel> = {}): BoardModel => ({
  snapshot: { sessions, attention, summaries: [], agent: { present: true, surfaceId: "watcher" } },
  focus: { slot: null, drafts: new Map(), input: null },
  names: { "s-alpha12345678": "alpha", "s-betaaaaaaaaaa": "beta", "s-gammaaaaaaaaa": "gamma" },
  width: 0,
  ...(over.orientation === undefined ? { orientation: "tilt needs approval before canary 2/3" } : {}),
  ...over,
});

const linesOf = (m: BoardModel): string[] => boardLines(m, () => 16, NOW).map((l) => l.text);

// ---- painter: layout zones --------------------------------------------------

describe("board painter — layout (docs/03 §Layout)", () => {
  it("orientation line: agent digest + counts", () => {
    const lines = linesOf(model());
    expect(lines[0]).toBe("hub · 3 sessions · 1 agent · tilt needs approval before canary 2/3");
  });

  it("orientation degrades to mechanical counts without the agent", () => {
    const m = model();
    const lines = linesOf({ ...m, orientation: undefined, snapshot: { ...m.snapshot, agent: { present: false, surfaceId: null } } } as unknown as BoardModel);
    expect(lines[0]).toBe("hub · 3 sessions");
  });

  it("NEEDS YOU rows carry kind, session name, item text; kind badges ordered oldest first", () => {
    const lines = linesOf(model());
    const needsYou = lines.filter((l) => l.startsWith("▎") && (l.includes("approval") || l.includes("question")) && !l.includes("●"));
    expect(needsYou.map((l) => l.slice(2, 12))).toEqual(["approval  ", "question  "]);
    expect(needsYou[0]).toContain("approval  alpha    approve deploy canary 2/3?");
    expect(needsYou[1]).toContain("question  beta     pin hub to 1.4 or latest?");
  });

  it("RUNNING digest: name, phase word, description, age — working and waiting sessions", () => {
    const lines = linesOf(model());
    const running = lines.filter((l) => l.includes("●"));
    expect(running).toHaveLength(2);
    expect(running[0]).toContain("● alpha    working  editing deploy/canary.sh (2m)");
    expect(running[1]).toContain("● beta     waiting  asked a question (2m)");
  });

  it("IDLE rows: name, idle, age, assign placeholder", () => {
    const lines = linesOf(model());
    const idle = lines.filter((l) => l.includes("○"));
    expect(idle).toHaveLength(1);
    expect(idle[0]).toContain("○ gamma    idle 2m   assign: _");
  });

  it("focused attention item renders the inline input cursor line with block cursor", () => {
    const lines = linesOf(
      model({ focus: { slot: { type: "attention", index: 0 }, drafts: new Map(), input: "yes ship" } }),
    );
    const cursor = lines.find((l) => l.includes("› yes ship█"));
    expect(cursor).toBeDefined();
  });

  it("typing at a mid-cursor position inserts before the cursor block", () => {
    const lines = linesOf(
      model({ focus: { slot: { type: "attention", index: 0 }, drafts: new Map(), input: "yes ship it", cursor: 4 } }),
    );
    expect(lines.find((l) => l.includes("› yes █ship it"))).toBeDefined();
  });

  it("typing on the idle row shows the live assign input with cursor", () => {
    const lines = linesOf(
      model({ focus: { slot: { type: "idle-assign", sessionId: "s-gammaaaaaaaaa" }, drafts: new Map(), input: "rewrite routes" } }),
    );
    expect(lines.find((l) => l.includes("assign: rewrite routes█"))).toBeDefined();
  });

  it("focused idle row without an open input keeps the assign placeholder", () => {
    const lines = linesOf(
      model({ focus: { slot: { type: "idle-assign", sessionId: "s-gammaaaaaaaaa" }, drafts: new Map(), input: null } }),
    );
    expect(lines.find((l) => l.includes("assign: _"))).toBeDefined();
  });

  it("footer full variant lists every key", () => {
    expect(linesOf(model()).at(-1)).toBe(FOOTER_FULL);
  });

  it("cells carry hue bars and theme tokens (paintBoard)", () => {
    const cells = paintBoard(model(), (id) => (id === "s-alpha12345678" ? 100 : 200), NOW);
    const needsYouRow = cells.find((row) => row.map((c) => c.ch).join("").includes("approval  alpha"));
    expect(needsYouRow).toBeDefined();
    expect(needsYouRow![0]).toEqual({ ch: "▎", fg: 100 });
    expect(needsYouRow![1]).toEqual({ ch: "▎", fg: 100 });
  });
});

// ---- painter: calm variant ---------------------------------------------------

describe("board painter — calm variant (docs/03 §Calm)", () => {
  const calmSessions = { "s-alpha12345678": session({ description: "watching canary metrics" }) };
  const calmModel = model({ snapshot: { sessions: calmSessions, attention: [], summaries: [], agent: { present: true, surfaceId: "watcher" } } });

  it("isCalm: no attention and no idle sessions", () => {
    expect(isCalm(calmModel.snapshot)).toBe(true);
    expect(isCalm(model().snapshot)).toBe(false);
  });

  it("zones collapse to muted (empty) lines; footer trims", () => {
    const lines = linesOf(calmModel);
    expect(lines).toContain("⚠ NEEDS YOU");
    expect(lines).toContain("  (empty)");
    expect(lines).toContain("💤 IDLE");
    expect(lines.at(-1)).toBe(FOOTER_CALM);
  });

  it("piped stdin footer wins over calm trim", () => {
    const lines = linesOf({ ...calmModel, inputsEnabled: false });
    expect(lines.at(-1)).toBe(FOOTER_PIPED);
  });
});

// ---- state machine -----------------------------------------------------------

const stateOf = (over: Partial<BoardSnapshot> = {}): BoardState => initialBoardState(reply(over));
const char = (c: string): Key => ({ kind: "char", char: c });

describe("board state — normalizeSnapshot (docs/03 §Layout 1)", () => {
  it("hub digest → orientation; agent kind row also marks agent present", () => {
    const n = normalizeSnapshot({ sessions, attention, hub: {} });
    expect(n.snapshot.agent.present).toBe(false);
    expect(n.orientation).toBeUndefined();
    const n2 = normalizeSnapshot({ sessions: { ...sessions, "s-agent000000": session({ kind: "agent" }) }, attention, hub: {} });
    expect(n2.snapshot.agent.present).toBe(true);
  });

  it("names extracted from session extras", () => {
    const n = normalizeSnapshot(reply());
    expect(n.names["s-alpha12345678"]).toBe("alpha");
  });
});

describe("board state — focus movement (docs/03 §Keys ↑↓)", () => {
  it("initial focus lands on the first attention item", () => {
    expect(stateOf().focus).toEqual({ type: "attention", index: 0 });
  });

  it("down walks items then idle rows; up wraps backwards", () => {
    let s = stateOf();
    s = applyKey(s, { kind: "down" }).state;
    expect(s.focus).toEqual({ type: "attention", index: 1 });
    s = applyKey(s, { kind: "down" }).state;
    expect(s.focus).toEqual({ type: "idle-assign", sessionId: "s-gammaaaaaaaaa" });
    s = applyKey(s, { kind: "down" }).state;
    expect(s.focus).toEqual({ type: "attention", index: 0 }); // wrap
    s = applyKey(s, { kind: "up" }).state;
    expect(s.focus).toEqual({ type: "idle-assign", sessionId: "s-gammaaaaaaaaa" });
  });

  it("moveFocus on an empty board stays null", () => {
    expect(moveFocus({ sessions: {}, attention: [], summaries: [], agent: { present: false, surfaceId: null } }, null, 1)).toBeNull();
  });
});

describe("board state — inline input lifecycle (docs/03 §Keys)", () => {
  it("typing appends into the focused input; esc blurs; typing again reopens", () => {
    let s = stateOf();
    s = applyKey(s, char("y")).state;
    s = applyKey(s, char("e")).state;
    expect(s.input).toBe("ye");
    s = applyKey(s, { kind: "escape" }).state;
    expect(s.input).toBeNull();
    s = applyKey(s, char("n")).state;
    expect(s.input).toBe("n");
  });

  it("backspace, left, right edit around the cursor", () => {
    let s = stateOf();
    for (const c of "zb") s = applyKey(s, char(c)).state; // z/b are not command keys
    s = applyKey(s, { kind: "left" }).state;
    s = applyKey(s, char("X")).state; // zXb
    expect(s.input).toBe("zXb");
    expect(s.cursor).toBe(2);
    s = applyKey(s, { kind: "backspace" }).state; // zb
    expect(s.input).toBe("zb");
    expect(s.cursor).toBe(1);
    s = applyKey(s, { kind: "right" }).state;
    s = applyKey(s, { kind: "right" }).state;
    s = applyKey(s, { kind: "backspace" }).state; // z
    expect(s.input).toBe("z");
  });

  it("arrows do not move focus while an input is open (esc blurs first)", () => {
    let s = stateOf();
    s = applyKey(s, char("h")).state;
    s = applyKey(s, { kind: "down" }).state;
    expect(s.focus).toEqual({ type: "attention", index: 0 });
    expect(s.input).toBe("h");
  });
});

describe("board state — enter commits (docs/03 §Layout 2/4, docs/06 flows)", () => {
  it("attention ⏎ → answer effect with the typed text; focus advances", () => {
    let s = stateOf();
    for (const c of "yes go") s = applyKey(s, char(c)).state;
    const { state, effect } = applyKey(s, { kind: "enter" });
    expect(effect).toEqual({ type: "answer", id: "att-1", text: "yes go" });
    expect(state.input).toBeNull();
    expect(state.focus).toEqual({ type: "attention", index: 1 }); // advanced
    expect(state.drafts.get("att:0")).toBe("yes go"); // per-session history
  });

  it("idle ⏎ → assign effect carrying sessionId + task", () => {
    let s = stateOf();
    s = applyKey(s, { kind: "down" }).state; // → att-2
    s = applyKey(s, { kind: "down" }).state; // → idle gamma
    for (const c of "rewrite routes") s = applyKey(s, char(c)).state;
    const { effect } = applyKey(s, { kind: "enter" });
    expect(effect).toEqual({ type: "assign", sessionId: "s-gammaaaaaaaaa", task: "rewrite routes" });
  });

  it("d on an attention item dismisses without replying; d is inert on idle rows", () => {
    const s = stateOf();
    const { effect } = applyKey(s, char("d"));
    expect(effect).toEqual({ type: "dismiss", id: "att-1" });
    const s2: BoardState = {
      ...stateOf(),
      focus: { type: "idle-assign", sessionId: "s-gammaaaaaaaaa" },
    };
    expect(applyKey(s2, char("d")).effect).toBeNull();
  });

  it("a jumps focus to the first idle row's assign input", () => {
    const { state } = applyKey(stateOf(), char("a"));
    expect(state.focus).toEqual({ type: "idle-assign", sessionId: "s-gammaaaaaaaaa" });
  });

  it("o opens the focused session's log overlay; q returns to the board", () => {
    let s = stateOf();
    s = applyKey(s, char("o")).state;
    expect(s.view).toBe("log");
    expect(s.logSessionId).toBe("s-alpha12345678");
    s = applyKey(s, char("q")).state;
    expect(s.view).toBe("board");
  });

  it("l opens the merged log overlay (all open sessions)", () => {
    const s = applyKey(stateOf(), char("l")).state;
    expect(s.view).toBe("log");
    expect(s.logSessionId).toBeNull();
  });

  it("q quits; ctrl-c quits from board and log overlay", () => {
    expect(applyKey(stateOf(), char("q")).effect).toEqual({ type: "quit" });
    expect(applyKey(stateOf(), { kind: "ctrl-c" }).effect).toEqual({ type: "quit" });
    const log = applyKey(stateOf(), char("l")).state;
    expect(applyKey(log, { kind: "ctrl-c" }).effect).toEqual({ type: "quit" });
  });

  it("unknown keys ignore without effect", () => {
    expect(applyKey(stateOf(), { kind: "ignore" }).effect).toBeNull();
  });
});

// ---- machine snapshot ---------------------------------------------------------

describe("board machine data (docs/03 §Machine modes)", () => {
  it("orientation + attention + running + idle shapes", () => {
    const data = boardMachineData(stateOf());
    expect(data.orientation).toBe("tilt needs approval before canary 2/3");
    expect((data.attention as AttentionItem[]).map((a) => a.id)).toEqual(["att-1", "att-2"]);
    const running = data.running as Array<{ id: string; name: string; phase: string; description: string }>;
    expect(running.map((r) => [r.id, r.phase])).toEqual([
      ["s-alpha12345678", "working"],
      ["s-betaaaaaaaaaa", "waiting"],
    ]);
    expect(running[0]!.description).toBe("editing deploy/canary.sh");
    const idle = data.idle as Array<{ id: string }>;
    expect(idle.map((i) => i.id)).toEqual(["s-gammaaaaaaaaa"]);
  });

  it("orientation null when the hub meta is absent", () => {
    const s = stateOf({ hub: {} });
    expect(boardMachineData(s).orientation).toBeNull();
  });
});
