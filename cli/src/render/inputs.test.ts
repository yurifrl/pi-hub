// cli/src/render/inputs.test.ts — key decoding (docs/03 §Raw-mode single
// keypress: one chunk → one key, escape sequences atomic, unknown multi-byte
// → ignore) and the readKeys stream over a fake TTY.
import { describe, it, expect } from "bun:test";
import { decodeKey, readKeys, type Key } from "./inputs";
import { PassThrough } from "node:stream";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytes = (...ns: number[]): Uint8Array => new Uint8Array(ns);

const text = (k: Key): string => (k.kind === "char" ? k.char : `<${k.kind}>`);

describe("decodeKey — single chars and control bytes", () => {
  it("printable ascii", () => {
    expect(text(decodeKey(enc("a")))).toBe("a");
    expect(text(decodeKey(enc("Z")))).toBe("Z");
    expect(text(decodeKey(enc("?")))).toBe("?");
    expect(text(decodeKey(enc(" ")))).toBe(" ");
  });

  it("enter / backspace", () => {
    expect(decodeKey(bytes(0x0d))).toEqual({ kind: "enter" });
    expect(decodeKey(bytes(0x0a))).toEqual({ kind: "enter" });
    expect(decodeKey(bytes(0x7f))).toEqual({ kind: "backspace" });
    expect(decodeKey(bytes(0x08))).toEqual({ kind: "backspace" });
  });

  it("ctrl-c is a key, never a signal", () => {
    expect(decodeKey(bytes(0x03))).toEqual({ kind: "ctrl-c" });
  });

  it("lone esc → escape", () => {
    expect(decodeKey(bytes(0x1b))).toEqual({ kind: "escape" });
  });

  it("other control bytes → ignore (never leak as text)", () => {
    expect(decodeKey(bytes(0x02)).kind).toBe("ignore");
    expect(decodeKey(bytes(0x1a)).kind).toBe("ignore");
  });
});

describe("decodeKey — escape sequences atomic", () => {
  it("CSI arrows", () => {
    expect(decodeKey(enc("\x1b[A"))).toEqual({ kind: "up" });
    expect(decodeKey(enc("\x1b[B"))).toEqual({ kind: "down" });
    expect(decodeKey(enc("\x1b[C"))).toEqual({ kind: "right" });
    expect(decodeKey(enc("\x1b[D"))).toEqual({ kind: "left" });
  });

  it("SS3 arrows (esc O A)", () => {
    expect(decodeKey(bytes(0x1b, 0x4f, 0x41))).toEqual({ kind: "up" });
    expect(decodeKey(bytes(0x1b, 0x4f, 0x42))).toEqual({ kind: "down" });
  });

  it("unknown CSI final → ignore", () => {
    expect(decodeKey(enc("\x1b[Z")).kind).toBe("ignore"); // shift-tab
    expect(decodeKey(enc("\x1b[1;5R")).kind).toBe("ignore"); // cursor position report
  });

  it("unknown esc pairs → ignore, never garbage text", () => {
    expect(decodeKey(bytes(0x1b, 0x1b)).kind).toBe("ignore");
    expect(decodeKey(bytes(0x1b, 0x6f)).kind).toBe("ignore");
  });

  it("tab and PgUp/PgDn; other tilde keys → ignore", () => {
    expect(decodeKey(bytes(0x09))).toEqual({ kind: "tab" });
    expect(decodeKey(enc("\x1b[5~"))).toEqual({ kind: "pageup" });
    expect(decodeKey(enc("\x1b[6~"))).toEqual({ kind: "pagedown" });
    expect(decodeKey(enc("\x1b[3~")).kind).toBe("ignore"); // delete
  });
});

describe("decodeKey — UTF-8", () => {
  it("multibyte char decodes whole", () => {
    expect(text(decodeKey(enc("é")))).toBe("é");
    expect(text(decodeKey(enc("█")))).toBe("█");
    expect(text(decodeKey(enc("⏎")))).toBe("⏎");
  });

  it("lone continuation byte → ignore", () => {
    expect(decodeKey(bytes(0xa9)).kind).toBe("ignore");
  });

  it("truncated multibyte → ignore", () => {
    expect(decodeKey(bytes(0xc3)).kind).toBe("ignore");
  });

  it("empty chunk → ignore", () => {
    expect(decodeKey(bytes()).kind).toBe("ignore");
  });
});

/**
 * One bun/PassThrough interleave turn — ensures each pushed chunk is
 * delivered as its own 'data' event before the next push (pushing faster
 * than the stream flushes coalesces chunks, which decodeKey resolves
 * one-key-per-chunk anyway).
 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("readKeys — raw-mode stream over fake TTY", () => {
  it("yields decoded keys in order, raw on at start / off at teardown", async () => {
    const stdin = new PassThrough();
    let raw = false;
    const keys = readKeys(stdin, (on) => (raw = on));
    expect(raw).toBe(true);

    stdin.push("a");
    await tick();
    stdin.push("\x1b[B"); // down
    await tick();
    stdin.push("\r");
    await tick();
    stdin.push(null); // EOF
    await tick();

    const collected: Key[] = [];
    for await (const k of keys) collected.push(k);
    expect(collected.map(text)).toEqual(["a", "<down>", "<enter>"]);

    expect(raw).toBe(true); // readKeys itself never disables raw; TerminalState owns restore
  });

  it("one chunk → one key: each pushed chunk decodes atomically", async () => {
    const stdin = new PassThrough();
    const keys = readKeys(stdin, () => {});
    stdin.push("h");
    stdin.push("i");
    stdin.push("\x1b[C");
    stdin.push(null);
    await tick();

    const collected: Key[] = [];
    for await (const k of keys) collected.push(k);
    expect(collected.map(text)).toEqual(["h", "i", "<right>"]);
  });

  it("EOF ends iteration", async () => {
    const stdin = new PassThrough();
    const keys = readKeys(stdin, () => {});
    stdin.push(null);
    await tick();
    await tick();
    const collected: Key[] = [];
    for await (const k of keys) collected.push(k);
    expect(collected).toHaveLength(0);
  });
});
