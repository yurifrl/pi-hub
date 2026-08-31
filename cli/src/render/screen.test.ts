// cli/src/render/screen.test.ts — double-buffer diff semantics, alt-screen
// idempotence, minimal-flush byte accounting (docs/03 §Screen buffer,
// §Alt-screen lifecycle).
import { describe, it, expect } from "bun:test";
import {
  ScreenBuffer,
  TerminalState,
  cellSgr,
  cursorTo,
  padRow,
  textRow,
  SEQ,
  type Cell,
} from "./screen";

/** Sink collecting write() output for assertions. */
const makeSink = (): { readonly text: string; write: (s: string) => void; reset: () => void } => {
  let buf = "";
  return {
    get text(): string {
      return buf;
    },
    write: (s: string) => {
      buf += s;
    },
    reset: () => {
      buf = "";
    },
  };
};

describe("ScreenBuffer — double-buffer diff", () => {
  it("first flush paints the full frame", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.write([textRow("hello")]);
    const n = b.flush();
    expect(n).toBeGreaterThan(0);
    expect(t.text).toContain("hello");
    expect(t.text).toContain(SEQ.home);
  });

  it("second flush with same frame writes nothing (zero diffs)", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    const frame = [textRow("line one"), textRow("line two")];
    b.write(frame);
    b.flush();
    t.reset();
    b.write(frame);
    const n = b.flush();
    expect(n).toBe(0);
    expect(t.text).toBe("");
  });

  it("changed row repaints; untouched rows stay silent", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.write([textRow("aaa"), textRow("bbb"), textRow("ccc")]);
    b.flush();
    t.reset();
    b.write([textRow("aaa"), textRow("XXX"), textRow("ccc")]);
    const n = b.flush();
    expect(n).toBeGreaterThan(0);
    expect(t.text).toContain("XXX");
    expect(t.text).not.toContain("aaa");
    expect(t.text).not.toContain("ccc");
    expect(t.text).toContain(cursorTo(2, 1)); // only row 2 moved
  });

  it("row count shrink: shorter frame clears removed rows", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.write([textRow("one"), textRow("two"), textRow("three")]);
    b.flush();
    t.reset();
    b.write([textRow("one")]);
    const n = b.flush();
    expect(n).toBeGreaterThan(0);
    // rows 2 and 3 were repainted as empty rows (cleared via EL)
    expect(t.text).toContain(cursorTo(2, 1));
    expect(t.text).toContain(cursorTo(3, 1));
  });

  it("staged-but-unflushed writes collapse into one flush", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.write([textRow("v1")]);
    b.write([textRow("v2")]);
    const n = b.flush();
    expect(n).toBeGreaterThan(0);
    expect(t.text).toContain("v2");
    expect(t.text).not.toContain("v1");
  });

  it("resize forces a repaint", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.write([textRow("x")]);
    b.flush();
    b.resize(80, 24);
    b.write([textRow("x")]);
    const n = b.flush();
    expect(n).toBeGreaterThan(0);
  });
});

describe("ScreenBuffer — alt-screen lifecycle", () => {
  it("enterAlt emits smcup + hideCursor once; leaveAlt emits showCursor + rmcup", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.enterAlt();
    expect(t.text).toBe(SEQ.smcup + SEQ.hideCursor);
    b.enterAlt(); // idempotent enter
    expect(t.text).toBe(SEQ.smcup + SEQ.hideCursor);
    b.leaveAlt();
    expect(t.text).toBe(SEQ.smcup + SEQ.hideCursor + SEQ.showCursor + SEQ.rmcup);
    b.leaveAlt(); // idempotent leave
    expect(t.text).toBe(SEQ.smcup + SEQ.hideCursor + SEQ.showCursor + SEQ.rmcup);
  });

  it("enter after leave is a fresh cycle (full repaint)", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.write([textRow("cycle 1")]);
    b.flush();
    b.enterAlt();
    b.write([textRow("cycle 2")]);
    b.flush();
    expect(t.text).toContain("cycle 2");
    expect(t.text).toContain(SEQ.clearScreen); // full paint after enterAlt
  });

  it("flush inside alt paints fully first (alt flips the baseline)", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    b.enterAlt();
    b.write([textRow("fresh")]);
    b.flush();
    expect(t.text).toContain(SEQ.clearScreen);
    b.write([textRow("fresh")]);
    expect(b.flush()).toBe(0); // then diffs normally
  });

  it("altActive tracks state", () => {
    const t = makeSink();
    const b = new ScreenBuffer(t.write);
    expect(b.altActive).toBe(false);
    b.enterAlt();
    expect(b.altActive).toBe(true);
    b.leaveAlt();
    expect(b.altActive).toBe(false);
  });
});

describe("TerminalState — alt + raw lifecycle", () => {
  it("enter once emits one smcup and enables raw once", () => {
    let raw = false;
    let rawWrites = 0;
    const t = makeSink();
    const term = new TerminalState(
      t.write,
      (on) => {
        raw = on;
        rawWrites++;
      },
    );
    term.enter();
    term.enter();
    expect(raw).toBe(true);
    expect(rawWrites).toBe(1);
    expect(t.text).toBe(SEQ.smcup + SEQ.hideCursor);
  });

  it("restore is idempotent: double restore = one rmcup + one raw-off", () => {
    let raw = true;
    const t = makeSink();
    const term = new TerminalState(t.write, (on) => (raw = on));
    term.enter();
    term.restore();
    term.restore();
    expect(raw).toBe(false);
    expect(t.text).toBe(SEQ.smcup + SEQ.hideCursor + SEQ.showCursor + SEQ.rmcup);
    expect(term.active).toBe(false);
  });

  it("restore without enter touches nothing", () => {
    let rawCalls = 0;
    const t = makeSink();
    const term = new TerminalState(t.write, () => rawCalls++);
    term.restore();
    expect(rawCalls).toBe(0);
    expect(t.text).toBe("");
  });
});

describe("cell encoding helpers", () => {
  it("cellSgr truecolor prefix + reset", () => {
    const cell: Cell = { ch: "x", fg: "err", bold: true };
    const sgr = cellSgr(cell, "truecolor");
    expect(sgr.on).toBe("\x1b[38;2;255;122;154;1m");
    expect(sgr.off).toBe("\x1b[0m");
  });

  it("plain level strips color; bold carries the emphasis", () => {
    const cell: Cell = { ch: "x", fg: "err", bg: "muted", bold: true };
    expect(cellSgr(cell, "plain")).toEqual({ on: "\x1b[1m", off: "\x1b[0m" });
    expect(cellSgr({ ch: "x", fg: "err" }, "plain")).toEqual({ on: "", off: "" });
  });

  it("textRow / padRow", () => {
    expect(textRow("ab")).toEqual([{ ch: "a" }, { ch: "b" }]);
    expect(padRow(textRow("a"), 3).map((c) => c.ch)).toEqual(["a", " ", " "]);
    expect(padRow(textRow("abc"), 2).map((c) => c.ch)).toEqual(["a", "b"]);
  });
});
