import { expect, test } from "bun:test";
import { decodeKey, type Key } from "./keys";

import { boardKey, initialBoardState, type BoardData } from "./rows";
import { initialState, stepWatch, type RailRow, type WatchState } from "./watch_view";

const ch = (c: string): Key => ({ kind: "char", ch: c });
const row = (id: string): RailRow => ({ id, name: id, kind: "roster", phase: "idle", glyph: "○", tone: "muted", open: 0 });
const ctrl = (name: string): Key => decodeKey({ name, ctrl: true, meta: false, sequence: "" });
const GEOM = { w: 100, h: 30 };

test("watch rail: j/k/g/G move the selection ", () => {
  const s0 = initialState([row("a"), row("b"), row("c")], []);
  const at = (s: typeof s0, k: Key) => stepWatch(s, k, GEOM).state;
  expect(at(s0, ch("j")).sel).toBe(1);
  expect(at(at(s0, ch("G")), ch("k")).sel).toBe(1);
  expect(at(at(s0, ch("G")), ch("g")).sel).toBe(0);
  expect(at(s0, ch("k")).sel).toBe(0);
});

test("watch compose: j/k/g/G are typed into the draft, not motions", () => {
  let s: WatchState = { ...initialState([row("a"), row("b")], []), focus: "compose" };
  for (const c of "jkgG") s = stepWatch(s, ch(c), GEOM).state;
  expect(s.draft.text).toBe("jkgG");
  expect(s.sel).toBe(0);
});

test("board: j/k/g/G/pagedown move focus; ignored while typing", () => {
  const idle = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `s${i}`, phase: "idle", description: "", since: null }));
  const data: BoardData = { orientation: "", attention: [], running: [], idle: idle(12) };
  const step = (st: typeof initialBoardState, k: Key) => boardKey(st, k, data).state;
  const down = step(initialBoardState, ch("j"));
  expect(down.focus).toBe(1);
  expect(step(down, ch("k")).focus).toBe(0);
  expect(step(initialBoardState, ch("G")).focus).toBe(11);
  expect(step(step(initialBoardState, ch("G")), ch("g")).focus).toBe(0);
  expect(step(initialBoardState, { kind: "pagedown" }).focus).toBe(8);
  expect(step(initialBoardState, ctrl("d")).focus).toBe(8);
  const typing = step(step(initialBoardState, ch("a")), ch("x"));
  expect(step(typing, ch("j")).focus).toBe(0);
  expect(step(typing, ch("j")).input.text).toBe("xj");
});
