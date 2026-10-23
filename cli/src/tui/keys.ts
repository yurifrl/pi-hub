// cli/src/tui/keys.ts - OpenTUI KeyEvent -> one logical key (spec §Rendering, raw-mode
// single keypress). OpenTUI's stdin parser consumes escape sequences atomically;
// anything it cannot name and that is not printable text decodes to {kind:"ignore"}
// so it never leaks into an input as garbage.

export type NavKind =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "tab"
  | "quit"
  | "ignore";

export type Key = { kind: NavKind } | { kind: "char"; ch: string };

/** The subset of OpenTUI's KeyEvent the decoder reads (keeps this module pure + testable). */
export type KeyLike = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  sequence: string;
  eventType?: "press" | "repeat" | "release";
};

const NAMED: Record<string, NavKind> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  return: "enter",
  enter: "enter",
  linefeed: "enter",
  escape: "escape",
  backspace: "backspace",
  delete: "delete",
  tab: "tab",
};

const CTRL: Record<string, NavKind> = {
  c: "quit",
  n: "down",
  p: "up",
  a: "home",
  e: "end",
  h: "backspace",
  d: "pagedown",
  u: "pageup",
};

const IGNORE: Key = { kind: "ignore" };
// no C0/C1 control characters, no DEL
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const decodeKey = (ev: KeyLike): Key => {
  if (ev.eventType === "release") return IGNORE;
  if (ev.ctrl) {
    const k = CTRL[ev.name];
    return k === undefined ? IGNORE : { kind: k };
  }
  if (ev.meta) return IGNORE;
  const named = NAMED[ev.name];
  if (named !== undefined) return { kind: named };
  if (ev.name === "space") return { kind: "char", ch: " " };
  const seq = ev.sequence;
  if (seq.length > 0 && [...seq].length === 1 && !CONTROL.test(seq)) return { kind: "char", ch: seq };
  return IGNORE;
};

// ---- single-line text input model (picker + board inline inputs) ----------------

export type TextInput = { text: string; cursor: number };

export const emptyInput: TextInput = { text: "", cursor: 0 };

/** Apply a key to a text input. Returns the same object when the key does not edit it. */
export const editInput = (input: TextInput, key: Key): TextInput => {
  const chars = [...input.text];
  const at = Math.min(input.cursor, chars.length);
  switch (key.kind) {
    case "char":
      chars.splice(at, 0, key.ch);
      return { text: chars.join(""), cursor: at + 1 };
    case "backspace":
      if (at === 0) return input;
      chars.splice(at - 1, 1);
      return { text: chars.join(""), cursor: at - 1 };
    case "delete":
      if (at >= chars.length) return input;
      chars.splice(at, 1);
      return { text: chars.join(""), cursor: at };
    case "left":
      return at === 0 ? input : { text: input.text, cursor: at - 1 };
    case "right":
      return at >= chars.length ? input : { text: input.text, cursor: at + 1 };
    case "home":
      return at === 0 ? input : { text: input.text, cursor: 0 };
    case "end":
      return at >= chars.length ? input : { text: input.text, cursor: chars.length };
    default:
      return input;
  }
};
