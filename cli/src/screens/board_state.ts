// cli/src/screens/board_state.ts — pure board state machine (docs/03-cli.md
// §hub (bare) Keys). applyKey: state + key in → state + effect out. No IO, no
// clock, no socket — the driver (board.ts) executes effects and feeds fresh
// snapshots back in. Pure enough to test the whole key matrix without a TTY.

import type { AttentionItem, SessionRecord, StatusSnapshot } from "@yurifrl/hub";
import { isCalm, moveFocus, type FocusSlot } from "../render/board";
import type { Key } from "../render/inputs";

/** One pending side effect the driver must execute (cmd frame or view change). */
export type BoardEffect =
  | { type: "answer"; id: string; text: string }
  | { type: "assign"; sessionId: string; task: string }
  | { type: "dismiss"; id: string }
  | { type: "open-log"; sessionId: string | null }
  | { type: "close-log" }
  | { type: "quit" }
  | null;

/** Full mutable state of the board screen. */
export type BoardState = {
  snapshot: StatusSnapshot;
  /** hub agent orientation sentence; absent → mechanical counts (docs/03 §Layout 1) */
  orientation?: string;
  /** display names by session id (list reply extras); first-8 fallback is the painter's */
  names: Record<string, string>;
  focus: FocusSlot | null;
  /** open inline input body; null = no input open */
  input: string | null;
  /** cursor position inside the open input */
  cursor: number;
  /** committed per-slot answer/assign drafts (per-session history) */
  drafts: Map<string, string>;
  /** board view or the o/l log overlay */
  view: "board" | "log";
  /** overlay scope: null = all open sessions merged (l), id = one session (o) */
  logSessionId: string | null;
};

/** The `attention`/`list` snapshot the driver fetched (hub reply, normalized). */
export type BoardSnapshot = {
  sessions: Record<string, SessionRecord>;
  attention: AttentionItem[];
  hub?: Record<string, unknown>;
};

/**
 * Normalize a hub list reply into the painter's StatusSnapshot + orientation +
 * names (docs/03 §hub: orientation = hub meta one-liner; agent present when
 * the meta carries it or an agent session row exists).
 */
export const normalizeSnapshot = (reply: BoardSnapshot): Pick<BoardState, "snapshot" | "orientation" | "names"> => {
  const hub = reply.hub ?? {};
  const sessions = reply.sessions ?? {};
  const digest = typeof hub.digest === "string" ? hub.digest : typeof hub.orientation === "string" ? (hub.orientation as string) : undefined;
  const agentSession = typeof hub.agentSession === "string" ? hub.agentSession : undefined;
  const agentPresent =
    digest !== undefined ||
    agentSession !== undefined ||
    Object.values(sessions).some((s) => s.kind === "agent");
  const names: Record<string, string> = {};
  for (const [id, rec] of Object.entries(sessions)) {
    const name = (rec as { name?: unknown }).name ?? (rec as { workerName?: unknown }).workerName;
    if (typeof name === "string" && name.length > 0) names[id] = name;
  }
  return {
    snapshot: {
      sessions,
      attention: reply.attention ?? [],
      summaries: [],
      agent: { present: agentPresent, surfaceId: agentSession !== undefined ? "watcher" : null },
    },
    ...(digest !== undefined ? { orientation: digest } : {}),
    names,
  };
};

/** Initial state: focus on the first interactive slot, input open (docs/03 sketch 1). */
export const initialBoardState = (reply: BoardSnapshot): BoardState => {
  const { snapshot, ...rest } = normalizeSnapshot(reply);
  const focus = moveFocus(snapshot, null, 1);
  return { snapshot, ...rest, focus, input: null, cursor: 0, drafts: new Map<string, string>(), view: "board", logSessionId: null };
};

/** Draft key for a slot: attention items by item id, idle rows by session id. */
const draftKey = (slot: FocusSlot): string => (slot.type === "attention" ? `att:${slot.index}` : `idle:${slot.sessionId}`);

/** Keys captured as commands when no input is open (docs/03 §Keys). */
const COMMAND_KEYS = new Set(["q", "d", "a", "o", "l"]);

/**
 * Apply one logical key to the board state (docs/03 §Keys table). Input-open
 * keys only act while an input is open; bare keys (d/a/o/l/q, arrows) only act
 * while it is closed — esc blurs first (docs/03: "esc | cancel the open input").
 */
export const applyKey = (state: BoardState, key: Key): { state: BoardState; effect: BoardEffect } => {
  if (state.view === "log") {
    // log overlay: q/esc return to the board (docs/03 §Keys o)
    if (key.kind === "char" && key.char === "q") return { state: { ...state, view: "board" }, effect: { type: "close-log" } };
    if (key.kind === "escape") return { state: { ...state, view: "board" }, effect: { type: "close-log" } };
    if (key.kind === "ctrl-c") return { state, effect: { type: "quit" } };
    return { state, effect: null };
  }

  const inputOpen = state.input !== null;
  const focus = state.focus;

  switch (key.kind) {
    case "ctrl-c":
      return { state, effect: { type: "quit" } };

    case "escape":
      if (!inputOpen) return { state, effect: null };
      return { state: { ...state, input: null }, effect: null }; // esc cancels the open input

    case "up":
    case "down": {
      if (inputOpen) return { state, effect: null }; // esc blurs first
      const next = moveFocus(state.snapshot, focus, key.kind === "up" ? -1 : 1);
      return { state: { ...state, focus: next }, effect: null };
    }

    case "char": {
      if (inputOpen) {
        const body = state.input ?? "";
        const cur = Math.min(state.cursor, body.length);
        return {
          state: { ...state, input: body.slice(0, cur) + key.char + body.slice(cur), cursor: cur + key.char.length },
          effect: null,
        };
      }
      if (focus === null) return { state, effect: null };
      if (COMMAND_KEYS.has(key.char)) {
        if (key.char === "q") return { state, effect: { type: "quit" } };
        if (key.char === "d" && focus.type === "attention") {
          const item = state.snapshot.attention[focus.index];
          if (item !== undefined) {
            // dismiss = resolve without replying (docs/03 §Keys d; §Decision attention dismiss)
            return { state, effect: { type: "dismiss", id: item.id } };
          }
          return { state, effect: null }; // no such item — inert
        }
        if (key.char === "a") {
          // jump focus to the first idle row's assign input (docs/03 §Keys a)
          const firstIdle = Object.entries(state.snapshot.sessions).find(([, s]) => s.phase === "idle");
          if (firstIdle === undefined) return { state, effect: null };
          return { state: { ...state, focus: { type: "idle-assign", sessionId: firstIdle[0] } }, effect: null };
        }
        if (key.char === "o") {
          // focused session's full log view (docs/03 §Keys o); q returns
          const sessionId = focus.type === "idle-assign" ? focus.sessionId : (state.snapshot.attention[focus.index]?.sessionId ?? null);
          return { state: { ...state, view: "log", logSessionId: sessionId }, effect: { type: "open-log", sessionId } };
        }
        if (key.char === "l") {
          // l — merged log of all open sessions
          return { state: { ...state, view: "log", logSessionId: null }, effect: { type: "open-log", sessionId: null } };
        }
        return { state, effect: null }; // command key inert in this context (e.g. d on idle rows)
      }
      // any other printable starts the inline input on the focused slot (docs/03 §Keys)
      return { state: { ...state, input: key.char, cursor: key.char.length }, effect: null };
    }

    case "enter": {
      if (!inputOpen || focus === null) return { state, effect: null };
      const text = state.input ?? "";
      const drafts = new Map(state.drafts);
      drafts.set(draftKey(focus), text);
      const cleared: BoardState = { ...state, drafts, input: null, cursor: 0 };
      if (focus.type === "attention") {
        const item = state.snapshot.attention[focus.index];
        if (item === undefined) return { state: cleared, effect: null };
        // ⏎ delivers through the send wire path and resolves the item (docs/03 §Layout 2)
        const next = moveFocus(state.snapshot, focus, 1);
        return { state: { ...cleared, focus: next }, effect: { type: "answer", id: item.id, text } };
      }
      // idle row ⏎ → assign {id, task}; session flips to working (docs/03 §Layout 4)
      const next = moveFocus(state.snapshot, focus, 1);
      return { state: { ...cleared, focus: next }, effect: { type: "assign", sessionId: focus.sessionId, task: text } };
    }

    case "backspace": {
      if (!inputOpen) return { state, effect: null };
      const body = state.input ?? "";
      const cur = Math.min(state.cursor, body.length);
      if (cur === 0) return { state, effect: null };
      return { state: { ...state, input: body.slice(0, cur - 1) + body.slice(cur), cursor: cur - 1 }, effect: null };
    }

    case "left": {
      if (!inputOpen) return { state, effect: null };
      return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, effect: null };
    }

    case "right": {
      if (!inputOpen) return { state, effect: null };
      const max = (state.input ?? "").length;
      return { state: { ...state, cursor: Math.min(max, state.cursor + 1) }, effect: null };
    }

    case "ignore":
      return { state, effect: null };
  }
};

/** Calm passthrough for the driver (docs/03 §Calm / empty variant). */
export const boardIsCalm = isCalm;
