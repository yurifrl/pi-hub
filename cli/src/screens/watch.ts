// cli/src/screens/watch.ts — `hub watch` state machine (docs/03-cli.md
// §hub watch): the split console — attention rail on top, live log below.
// Pure: frames + keys in → new state + paint plan out. The concrete host
// (cmd_watch.ts) owns raw stdin, alt-screen, and the poll/fallback tick.
//
// Modes (docs/03): `l` log-only (attention rail hidden), `a` attention-only
// (log pane hidden), `1-9` pin the nth session to the log pane (pin again to
// unpin), `/` filter prompt (substring across session name and entry text;
// esc clears), `q` quit. Attention rail keeps the board's inline model in
// full: type + ⏎ answers through cmd `send`, `d` dismisses (cmd `attention`
// dismiss). Hub loss degrades: rail renders `(hub offline)`, log pane keeps
// tailing files — offline is a rendered state, never an exit (docs/03).

import type { AttentionItem, LogEntry, StatusFile, StatusSnapshot } from "@yurifrl/hub";
import { boardLines, moveFocus, type BoardLine, type BoardModel, type BoardFocus } from "../render/board";
import { streamLines, filterEntries, type StreamLine } from "../render/stream";
import { hueIndex } from "../render/theme";
import type { FeedEvent } from "../hub_events";
import type { Key } from "../render/inputs";

/** Rail visibility (docs/03 §hub watch keys l/a). */
export type WatchMode = "split" | "log-only" | "attention-only";

export type WatchState = {
  mode: WatchMode;
  /** pinned session (nth open session by insertion order, 1-indexed keys 1-9) */
  pin: string | null;
  /** filter query, empty = off */
  filter: string;
  /** filter prompt open (typing feeds `filter`) */
  filterOpen: boolean;
  /** merged log tail across open sessions, oldest first */
  entries: LogEntry[];
  /** last known status.json (fallback tick re-reads; hub loss freezes it) */
  status: StatusFile | null;
  /** hub connection lost — rail degrades to (hub offline) */
  offline: boolean;
  /** board-family focus model for the attention rail */
  focus: BoardFocus;
  /** latest orientation sentence seen (status.digest synthesized upstream) */
  orientation: string | undefined;
  /** last dismiss/answer failure — inline err line in the rail */
  railError: string | null;
};

export const initialWatchState = (status: StatusFile | null): WatchState => ({
  mode: "split",
  pin: null,
  filter: "",
  filterOpen: false,
  entries: [],
  status,
  offline: false,
  focus: { slot: null, drafts: new Map(), input: null },
  orientation: undefined,
  railError: null,
});

/** Open session ids in status.json insertion order (pin numbering basis). */
export const openSessionIds = (status: StatusFile | null): string[] =>
  status === null
    ? []
    : Object.entries(status.sessions)
        .filter(([, rec]) => rec.status === "open")
        .map(([id]) => id);

/** Apply one decoded hub event (docs/02 §Event frames payloads). */
export const applyEvent = (s: WatchState, evt: FeedEvent): WatchState => {
  const p = evt.payload as Record<string, unknown>;
  switch (evt.topic) {
    case "log": {
      const entry: LogEntry = {
        t: typeof p.t === "number" ? p.t : Date.now(),
        sessionId: String(p.sessionId ?? ""),
        kind: p.kind as LogEntry["kind"],
        text: String(p.text ?? ""),
        ...(p.meta !== undefined && p.meta !== null ? { meta: p.meta as Record<string, unknown> } : {}),
      };
      return { ...s, entries: appendEntry(s.entries, entry) };
    }
    case "summary":
      return s; // rail material comes from summaries.jsonl reads, not the live tail
    case "attention":
      // payload is the touched item (removal carries resolvedAt) — refresh via
      // the next fallback tick; live add/remove patches the rail now
      return patchAttention(s, p as unknown as AttentionItem);
    case "phase": {
      const id = String(p.sessionId ?? "");
      if (s.status === null || s.status.sessions[id] === undefined) return s;
      const rec = { ...s.status.sessions[id]!, phase: p.phase as StatusFile["sessions"][string]["phase"] };
      return { ...s, status: { ...s.status, sessions: { ...s.status.sessions, [id]: rec } } };
    }
    case "status":
      return s; // snapshot material — the fallback tick re-reads status.json
    default:
      return s;
  }
};

const MAX_ENTRIES = 500;

const appendEntry = (entries: LogEntry[], e: LogEntry): LogEntry[] => {
  const next = [...entries, e];
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
};

/** attention event payload: touched item; a resolvedAt item leaves the rail. */
const patchAttention = (s: WatchState, item: AttentionItem): WatchState => {
  if (s.status === null) return s;
  const rest = s.status.attention.filter((a) => a.id !== item.id);
  const attention = item.resolvedAt !== undefined ? rest : [...rest, item];
  return { ...s, status: { ...s.status, attention } };
};

export type KeyAction =
  | { type: "state"; state: WatchState }
  | { type: "quit" }
  | { type: "answer"; itemId: string; sessionId: string; text: string }
  | { type: "dismiss"; itemId: string };

/**
 * One key against the state (docs/03 §hub watch keys). `openCount` bounds the
 * 1-9 pin range. Filter prompt consumes chars/⌫/⏎; esc closes + clears.
 * Attention edits delegate to the board focus model (drafts + input).
 */
export const applyKey = (s: WatchState, key: Key, _openCount: number): KeyAction => {
  // quit wins everywhere
  if (key.kind === "ctrl-c") return { type: "quit" };
  if (key.kind === "char" && key.char === "q" && !s.filterOpen && s.focus.input === null) return { type: "quit" };

  // filter prompt open: it owns the keyboard
  if (s.filterOpen) {
    if (key.kind === "escape") return { type: "state", state: { ...s, filterOpen: false, filter: "" } };
    if (key.kind === "enter") return { type: "state", state: { ...s, filterOpen: false } };
    if (key.kind === "backspace") return { type: "state", state: { ...s, filter: s.filter.slice(0, -1) } };
    if (key.kind === "char") return { type: "state", state: { ...s, filter: s.filter + key.char } };
    return { type: "state", state: s };
  }

  // an open attention input consumes typing (docs/03: type + ⏎ answers, esc cancels)
  if (s.focus.input !== null) {
    if (key.kind === "escape") return { type: "state", state: { ...s, focus: { ...s.focus, input: null } } };
    if (key.kind === "enter") {
      const slot = s.focus.slot;
      if (slot === null || slot.type !== "attention") return { type: "state", state: { ...s, focus: { ...s.focus, input: null } } };
      const item = s.status?.attention[slot.index];
      if (item === undefined) return { type: "state", state: { ...s, focus: { ...s.focus, input: null } } };
      const text = s.focus.input;
      const drafts = new Map(s.focus.drafts);
      drafts.set(item.id, text);
      return {
        type: "answer",
        itemId: item.id,
        sessionId: item.sessionId,
        text,
        // commit: clear input, keep draft as history (docs/03 board focus model)
        state: { ...s, focus: { slot: null, drafts, input: null } },
      } as KeyAction & { state: WatchState };
    }
    if (key.kind === "backspace") return { type: "state", state: { ...s, focus: { ...s.focus, input: s.focus.input.slice(0, -1) } } };
    if (key.kind === "char") return { type: "state", state: { ...s, focus: { ...s.focus, input: s.focus.input + key.char } } };
    return { type: "state", state: s };
  }

  // mode + pin + filter keys
  if (key.kind === "char") {
    if (key.char === "l") return { type: "state", state: { ...s, mode: s.mode === "log-only" ? "split" : "log-only" } };
    if (key.char === "a") {
      // attention-only mode; on a bare board `a` jumps to the first idle assign
      // input — watch keeps the mode meaning (docs/03 §hub watch)
      return { type: "state", state: { ...s, mode: s.mode === "attention-only" ? "split" : "attention-only" } };
    }
    if (key.char === "/") return { type: "state", state: { ...s, filterOpen: true } };
    if (key.char >= "1" && key.char <= "9") {
      const n = Number.parseInt(key.char, 10);
      const ids = openSessionIds(s.status);
      if (n >= 1 && n <= Math.min(9, ids.length)) {
        const target = ids[n - 1]!;
        return { type: "state", state: { ...s, pin: s.pin === target ? null : target } };
      }
      return { type: "state", state: s };
    }
    return { type: "state", state: s };
  }

  // focus movement / dismiss / edit-start live in the rail
  return { type: "state", state: s };
};

/** Open the inline answer input on the first attention item (docs/03 key `a`... board `type to answer`). */
export const startFirstAnswer = (s: WatchState): WatchState => {
  if (s.status === null || s.status.attention.length === 0) return s;
  return { ...s, focus: { ...s.focus, slot: { type: "attention", index: 0 }, input: "" } };
};

/** Move rail focus (↑↓ handled by the host loop calling this). */
export const moveRailFocus = (s: WatchState, delta: 1 | -1): WatchState => {
  if (s.status === null) return s;
  const slot = moveFocus(s.status as never, s.focus.slot, delta);
  return { ...s, focus: { ...s.focus, slot } };
};

/** Dismiss the focused item (docs/03 board `d` key → cmd attention dismiss). */
export const dismissFocused = (s: WatchState): KeyAction => {
  const slot = s.focus.slot;
  if (slot === null || slot.type !== "attention" || s.status === null) return { type: "state", state: s };
  const item = s.status.attention[slot.index];
  if (item === undefined) return { type: "state", state: s };
  return { type: "dismiss", itemId: item.id };
};

/** The rail's board model — watch paints the same lines the bare board does. */
export const railModel = (s: WatchState, width: number): BoardModel => ({
  snapshot: {
    sessions: s.status?.sessions ?? {},
    attention: s.status?.attention ?? [],
    summaries: [],
    agent: { present: s.status?.agentSession !== undefined, surfaceId: null },
  } as StatusSnapshot,
  focus: s.focus,
  ...(s.orientation !== undefined ? { orientation: s.orientation } : {}),
  width,
});
/** Rail lines with the offline degrade (docs/03: `(hub offline)` muted). */
export const railLines = (s: WatchState, width: number, now: number): BoardLine[] => {
  const lines = boardLines(railModel(s, width), hueIndex, now);
  if (!s.offline) return lines;
  return [{ text: "(hub offline)", segs: [["(hub offline)", "muted" as const]] }, ...lines];
};

/** Log-pane stream lines: pinned → that session only; filtered → substring match. */
export const paneLines = (s: WatchState, hueOf: (id: string) => number, width = 0): StreamLine[] => {
  const entries = s.pin !== null ? s.entries.filter((e) => e.sessionId === s.pin) : s.entries;
  return streamLines(filterEntries(entries, s.filter), hueOf, width);
};
