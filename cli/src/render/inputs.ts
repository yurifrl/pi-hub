// cli/src/render/inputs.ts — raw-mode single keypress (docs/03-cli.md
// §Rendering → Raw-mode single keypress): each read chunk decodes to at most
// one logical key; escape sequences consumed atomically; unknown multi-byte
// sequences map to ignore and never leak as garbage text; ctrl-c arrives as
// a key, not a signal. Non-TTY stdin never enables raw mode.

/** Logical keys the board family understands (docs/03 §inputs.ts type). */
export type Key =
  | { kind: "char"; char: string }
  | { kind: "up" | "down" | "enter" | "escape" | "backspace" | "left" | "right" | "tab" | "pageup" | "pagedown" }
  | { kind: "ctrl-c" }
  | { kind: "ignore" };

/** CSI final bytes for arrow keys (esc [ A/B/C/D). */
const ARROW_FINALS: Record<string, Key["kind"] & string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
};

/**
 * Decode one stdin chunk into at most one logical Key (docs/03: "each read
 * chunk decodes to at most one logical key — escape sequences are consumed
 * atomically, unknown multi-byte sequences map to ignore").
 */
export const decodeKey = (buf: Uint8Array): Key => {
  if (buf.length === 0) return { kind: "ignore" };
  const b0 = buf[0]!;

  // ctrl chars (raw mode delivers them as single bytes)
  if (b0 === 0x03) return { kind: "ctrl-c" };
  if (b0 === 0x09) return { kind: "tab" };
  if (b0 === 0x0d || b0 === 0x0a) return { kind: "enter" };
  if (b0 === 0x7f || b0 === 0x08) return { kind: "backspace" };
  if (b0 === 0x1b) {
    if (buf.length === 1) return { kind: "escape" };
    // CSI: esc [ <params?> <final>
    if (buf[1] === 0x5b) {
      if (buf.length < 3) return { kind: "ignore" }; // partial sequence — nothing usable in-chunk
      const final = String.fromCharCode(buf[buf.length - 1]!);
      if (final === "~") {
        // esc [ 5 ~ / esc [ 6 ~ — PgUp / PgDn; other tilde keys (home/del/…) ignored
        const params = new TextDecoder().decode(buf.slice(2, buf.length - 1));
        if (params === "5") return { kind: "pageup" };
        if (params === "6") return { kind: "pagedown" };
        return { kind: "ignore" };
      }
      const arrow = ARROW_FINALS[final];
      if (arrow !== undefined) return { kind: arrow } as Key;
      return { kind: "ignore" }; // unknown multi-byte → never leaks as text
    }
    // esc O A/B/C/D (SS3 arrows)
    if (buf[1] === 0x4f && buf.length >= 3) {
      const arrow = ARROW_FINALS[String.fromCharCode(buf[2]!)];
      if (arrow !== undefined) return { kind: arrow } as Key;
    }
    return { kind: "ignore" }; // alt-combos and unknown esc pairs
  }
  if (b0 < 0x20) return { kind: "ignore" }; // other control bytes

  // UTF-8: decode the full sequence; a lone continuation byte is ignore
  if (b0 < 0x80) return { kind: "char", char: String.fromCharCode(b0) };
  const len = b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc0 ? 2 : 0;
  if (len === 0 || buf.length < len) return { kind: "ignore" };
  return { kind: "char", char: new TextDecoder().decode(buf.slice(0, len)) };
};

/**
 * Raw-mode single keypress stream over a stdin-like source (docs/03:
 * "stdin runs in raw mode; each read chunk decodes to at most one logical
 * key"). `enableRaw` is injected so tests drive a fake TTY without termios;
 * the concrete host passes stdin.setRawMode. The async iterator yields
 * decoded Keys until the stream ends (EOF → iteration completes).
 */
export const readKeys = (
  stdin: NodeJS.ReadableStream,
  enableRaw: (on: boolean) => void,
): AsyncIterable<Key> => {
  const queue: Key[] = [];
  const resolvers: ((k: Key | null) => void)[] = [];
  let ended = false;
  // Escape sequences can arrive split across read chunks (tmux send-keys,
  // slow terminals): a chunk ending inside an unfinished CSI is held back and
  // merged with the next chunk instead of decoding as `escape` + garbage.
  let pending: number[] = [];

  const partialEscape = (bytes: number[]): boolean => {
    const esc = bytes.lastIndexOf(0x1b);
    if (esc < 0) return false;
    const tail = bytes.slice(esc);
    if (tail.length === 1) return true; // lone trailing ESC
    if (tail[1] !== 0x5b && tail[1] !== 0x4f) return false; // '[' or 'O' only
    const final = tail[tail.length - 1]!;
    const done = (final >= 0x40 && final <= 0x7e) && tail.length > 2;
    return !done;
  };

  const pump = (k: Key | null): void => {
    if (k === null) {
      ended = true;
      while (resolvers.length > 0) resolvers.shift()!(null);
      return;
    }
    if (resolvers.length > 0) resolvers.shift()!(k);
    else queue.push(k);
  };

  stdin.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    const wasLoneEsc = pending.length === 1 && pending[0] === 0x1b;
    const merged = pending.length > 0 ? Uint8Array.from([...pending, ...bytes]) : bytes;
    pending = [];
    if (merged.length > 0 && merged.length <= 64 && partialEscape(Array.from(merged))) {
      pending = Array.from(merged); // hold back the unfinished sequence
      return;
    }
    // A lone ESC held from the previous chunk followed by a printable char is
    // an escape press then that char (tmux send-keys, fast typing); a
    // completed CSI ([ or O introducer) still decodes whole.
    const frag = Array.from(merged);
    if (wasLoneEsc && frag.length > 1 && frag[0] === 0x1b && !(frag[1] === 0x5b || frag[1] === 0x4f)) {
      pump(decodeKey(new Uint8Array([0x1b])));
      pump(decodeKey(new Uint8Array(frag.slice(1))));
      return;
    }
    pump(decodeKey(merged));
  });
  stdin.on("end", () => {
    if (pending.length > 0) {
      pump(decodeKey(Uint8Array.from(pending))); // trailing fragment decodes or ignores
      pending = [];
    }
    pump(null);
  });
  stdin.on("close", () => pump(null));

  enableRaw(true);

  const next = (): Promise<Key | null> =>
    new Promise((resolve) => {
      if (queue.length > 0) resolve(queue.shift()!);
      else if (ended) resolve(null);
      else resolvers.push(resolve);
    });

  const iterable: AsyncIterable<Key> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const k = await next();
        return k === null ? { done: true as const, value: undefined } : { done: false as const, value: k };
      },
    }),
  };
  return iterable;
};
