// cli/src/screens/watch.ts — `hub watch` state machine (docs/03-cli.md
// §hub watch): the chat console — a sessions rail on the left (one symbol per
// session: working / waiting / done / blocked / needs you, plus an unread
// count), the selected session's conversation on the right, a compose line
// underneath. Pure: frames + keys in → new state + actions out. The concrete
// host (cmd_watch.ts) owns raw stdin, alt-screen, the log tails and the
// poll/fallback tick; render/watch_view.ts paints a state.
//
// Keys. Rail focus: ↑↓ select · 1-9 jump · ⏎/Tab/→ write · PgUp/PgDn scroll ·
// d dismiss the session's open attention item · q quit. Compose focus: type,
// ⏎ sends (cmd `send`; or cmd `answer` when the session has an open attention
// item — the reply goes where the question came from), esc/Tab back to the
// rail. Hub loss degrades: the header shows offline, files keep tailing —
// offline is a rendered state, never an exit (docs/03).

import type { AttentionItem, LogEntry, SessionRecord, StatusFile, ThemeToken } from "@yurifrl/hub";
import type { FeedEvent } from "../hub_events";
import type { Key } from "../render/inputs";

/** Rail width bounds (docs/03 §watch layout): `<`/`>` shrink/grow between them. */
export const RAIL_MIN = 14;
export const RAIL_MAX = 60;
export const RAIL_DEFAULT = 24;

export type WatchFocus = "rail" | "compose";

/** Transient footer line: send result or a refused command. */
export type Notice = { text: string; tone: "ok" | "err" };

export type WatchState = {
  focus: WatchFocus;
  /** selected session id; null only while there are no sessions */
  selected: string | null;
  /** per-session conversation tail, oldest first, capped at MAX_ENTRIES */
  entries: Record<string, LogEntry[]>;
  /** per-session count of entries that arrived while another session was selected */
  unread: Record<string, number>;
  /** per-session compose draft (survives switching sessions) */
  drafts: Record<string, string>;
  /** lines scrolled up from the bottom of the selected conversation */
  scroll: number;
  /** last known status.json (fallback tick re-reads; hub loss freezes it) */
  status: StatusFile | null;
  /** archived + log-only rail rows, newest first (docs/03 §watch rail) */
  extras: RailExtra[];
  /** chat message-kind filter, cycled with f (docs/03 §watch chat) */
  filter: ChatFilter;
  /** hub connection lost */
  offline: boolean;
  /** rail column width in cells; < / > resize between RAIL_MIN and RAIL_MAX */
  railWidth: number;
  orientation: string | undefined;
  notice: Notice | null;
};

/** What the painter can currently show — the host measures it so scrolling clamps. */
export type ViewMetrics = { pageRows: number; maxScroll: number };

export const MAX_ENTRIES = 400;

/** One rail row outside the live sessions map: a closed (archived) or log-only session.
 * `name` is the display label — the omp transcript title (or cwd basename); the
 * host resolves it from the machine's transcript tree, not the hub roster. */
export type RailExtra = { id: string; phase: "closed" | "log"; name: string };

/** Chat message-kind filter (docs/03 §watch chat): f cycles. */
export type ChatFilter = "all" | "user" | "assistant" | "tool";

export const FILTERS: readonly ChatFilter[] = ["all", "user", "assistant", "tool"];

/** `f`: all → user → assistant → tool → all. */
export const cycleFilter = (filter: ChatFilter): ChatFilter => FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length]!;

/** Rail cap for extras (docs/03 §watch: the 200 most recent log-only sessions). */
export const MAX_EXTRAS = 200;

/**
 * The rail's session ids: status.json sessions first (insertion order — the
 * 1-9 basis), then archived + log-only extras not already listed, newest
 * first, capped at MAX_EXTRAS (docs/03 §watch rail: every session is visible).
 */
export const railIds = (status: StatusFile | null, extra: RailExtra[] = []): string[] => {
  const live = status === null ? [] : Object.keys(status.sessions);
  const known = new Set(live);
  const rest: string[] = [];
  for (const e of extra) {
    if (known.has(e.id)) continue;
    known.add(e.id);
    rest.push(e.id);
  }
  return [...live, ...rest].slice(0, live.length + MAX_EXTRAS);
};

/**
 * Archived + log-only rail extras from status `archived[]` and the most
 * recent log files, newest first (docs/03 §watch rail). The host computes
 * recentLogIds; here we just merge, order, and label: the `names` map (from
 * the transcript scan) supplies each row's display name, falling back to the
 * id prefix.
 */
export const railExtras = (status: StatusFile | null, recentLogIds: string[], names: Record<string, string> = {}): RailExtra[] => {
  const label = (id: string): string => (names[id] !== undefined && names[id] !== "" ? names[id] : id.slice(0, 8));
  const archived = (status?.archived ?? []).map((a) => ({ id: a.id, phase: "closed" as const, name: label(a.id) }));
  const known = new Set([...(status === null ? [] : Object.keys(status.sessions)), ...archived.map((a) => a.id)]);
  const logs: RailExtra[] = [];
  for (const id of recentLogIds) {
    if (known.has(id)) continue;
    known.add(id);
    logs.push({ id, phase: "log" as const, name: label(id) });
  }
  return [...archived, ...logs];
};

/** Keep `selected` valid against the current session set; selecting reads the session. */
export const ensureSelection = (s: WatchState, extra: RailExtra[] = []): WatchState => {
  const ids = railIds(s.status, extra);
  if (ids.length === 0) return s.selected === null ? s : { ...s, selected: null, scroll: 0 };
  if (s.selected !== null && ids.includes(s.selected)) return s;
  return selectSession(s, ids[0]!);
};

export const initialWatchState = (status: StatusFile | null, extra: RailExtra[] = []): WatchState =>
  ensureSelection(
    {
      focus: "rail",
      selected: null,
      entries: {},
      unread: {},
      drafts: {},
      scroll: 0,
      status,
      extras: extra,
      filter: "all",
      offline: false,
      railWidth: RAIL_DEFAULT,
      orientation: status?.digest,
      notice: null,
    },
    extra,
  );

/** Make `id` the open conversation: scroll to the bottom, mark it read. */
export const selectSession = (s: WatchState, id: string): WatchState => {
  const { [id]: _read, ...unread } = s.unread;
  void _read;
  return { ...s, selected: id, scroll: 0, unread };
};

/** Unresolved attention items raised by `sessionId`, oldest first. */
export const openAttention = (s: WatchState, sessionId: string): AttentionItem[] =>
  (s.status?.attention ?? []).filter((a) => a.sessionId === sessionId && a.resolvedAt === undefined);

/** Rail label: the working directory's basename, else the id prefix. */
export const sessionName = (id: string, rec: SessionRecord | undefined): string =>
  rec?.cwd.split("/").filter((p) => p.length > 0).pop() ?? id.slice(0, 8);

/**
 * The rail symbol: needs-you wins; otherwise the phase — one icon per state,
 * never color alone (docs/03 §watch rail): working ▶, waiting ?, idle ○,
 * done ✓, blocked ✖; archived ■, log-only □, closing ·.
 */
export const sessionGlyph = (rec: SessionRecord | undefined, needsYou: boolean): { glyph: string; token: ThemeToken } => {
  if (rec === undefined) return { glyph: "□", token: "muted" };
  if (rec.status === "closing") return { glyph: "·", token: "muted" };
  if (needsYou) return { glyph: "⚠", token: "warn" };
  switch (rec.phase) {
    case "working":
      return { glyph: "▶", token: "accent" };
    case "waiting":
      return { glyph: "?", token: "warn" };
    case "blocked":
      return { glyph: "✖", token: "err" };
    case "idle":
      return { glyph: "○", token: "muted" };
    default:
      return { glyph: "✓", token: "ok" };
  }
};

/**
 * Fold freshly tailed entries of one session into the state. `live` entries
 * (appended after the first read) count as unread when another session is
 * open; the first read of a file is history and never does.
 */
export const mergeEntries = (s: WatchState, sessionId: string, fresh: LogEntry[], live: boolean): WatchState => {
  if (fresh.length === 0) return s;
  const all = [...(s.entries[sessionId] ?? []), ...fresh];
  const entries = { ...s.entries, [sessionId]: all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all };
  const bump = live && sessionId !== s.selected ? fresh.filter((e) => e.kind !== "user_message").length : 0;
  const unread = bump > 0 ? { ...s.unread, [sessionId]: (s.unread[sessionId] ?? 0) + bump } : s.unread;
  return { ...s, entries, unread };
};

/**
 * Apply one decoded hub event (docs/02 §Event frames payloads). Conversation
 * entries are NOT taken from `log` frames: the file tail is the single source,
 * so a frame arriving while the tail also reads the file can never double a line.
 */
export const applyEvent = (s: WatchState, evt: FeedEvent): WatchState => {
  const p = evt.payload as Record<string, unknown>;
  switch (evt.topic) {
    case "attention":
      return patchAttention(s, p as unknown as AttentionItem);
    case "phase": {
      const id = String(p.sessionId ?? "");
      if (s.status === null || s.status.sessions[id] === undefined) return s;
      const rec = { ...s.status.sessions[id]!, phase: p.phase as SessionRecord["phase"] };
      return { ...s, status: { ...s.status, sessions: { ...s.status.sessions, [id]: rec } } };
    }
    default:
      return s; // log: tail owns entries; summary/status: the fallback tick re-reads
  }
};

/** attention event payload: touched item; a resolvedAt item leaves the rail. */
const patchAttention = (s: WatchState, item: AttentionItem): WatchState => {
  if (s.status === null) return s;
  const rest = s.status.attention.filter((a) => a.id !== item.id);
  const attention = item.resolvedAt !== undefined ? rest : [...rest, item];
  return { ...s, status: { ...s.status, attention } };
};

export type KeyAction =
  | { type: "quit" }
  | { type: "state"; state: WatchState }
  | { type: "send"; sessionId: string; text: string; state: WatchState }
  | { type: "answer"; itemId: string; sessionId: string; text: string; state: WatchState }
  | { type: "dismiss"; itemId: string; state: WatchState };

const moveSelection = (s: WatchState, delta: 1 | -1): WatchState => {
  const ids = railIds(s.status, s.extras);
  if (ids.length === 0) return s;
  const at = s.selected === null ? -1 : ids.indexOf(s.selected);
  const next = Math.min(ids.length - 1, Math.max(0, at + delta));
  return ids[next] === s.selected ? s : selectSession(s, ids[next]!);
};

const scrollBy = (s: WatchState, delta: number, view: ViewMetrics): WatchState => ({
  ...s,
  scroll: Math.min(view.maxScroll, Math.max(0, s.scroll + delta)),
});

/** One key against the state. Every non-quit action carries the next state. */
export const applyKey = (prev: WatchState, key: Key, view: ViewMetrics): KeyAction => {
  if (key.kind === "ctrl-c") return { type: "quit" };
  const s: WatchState = prev.notice === null ? prev : { ...prev, notice: null };

  if (key.kind === "pageup") return { type: "state", state: scrollBy(s, view.pageRows, view) };
  if (key.kind === "pagedown") return { type: "state", state: scrollBy(s, -view.pageRows, view) };

  if (s.focus === "compose") return composeKey(s, key);

  // rail focus
  switch (key.kind) {
    case "up":
      return { type: "state", state: moveSelection(s, -1) };
    case "down":
      return { type: "state", state: moveSelection(s, 1) };
    case "enter":
    case "tab":
    case "right":
      return { type: "state", state: s.selected === null ? s : { ...s, focus: "compose" } };
    case "char": {
      if (key.char === "q") return { type: "quit" };
      if (key.char >= "1" && key.char <= "9") {
        const id = railIds(s.status, s.extras)[Number.parseInt(key.char, 10) - 1];
        return { type: "state", state: id === undefined ? s : selectSession(s, id) };
      }
      if (key.char === "f") return { type: "state", state: { ...s, filter: cycleFilter(s.filter), scroll: 0 } };
      if (key.char === "<") return { type: "state", state: { ...s, railWidth: Math.max(RAIL_MIN, s.railWidth - 4) } };
      if (key.char === ">") return { type: "state", state: { ...s, railWidth: Math.min(RAIL_MAX, s.railWidth + 4) } };
      if (key.char === "d") return dismissSelected(s);
      return { type: "state", state: s };
    }
    default:
      return { type: "state", state: s };
  }
};

/** `d`: dismiss the selected session's oldest open attention item (cmd attention dismiss). */
const dismissSelected = (s: WatchState): KeyAction => {
  const item = s.selected === null ? undefined : openAttention(s, s.selected)[0];
  return item === undefined ? { type: "state", state: s } : { type: "dismiss", itemId: item.id, state: s };
};

const composeKey = (s: WatchState, key: Key): KeyAction => {
  const id = s.selected;
  if (id === null) return { type: "state", state: { ...s, focus: "rail" } };
  const draft = s.drafts[id] ?? "";
  const withDraft = (text: string, over: Partial<WatchState> = {}): WatchState => ({ ...s, ...over, drafts: { ...s.drafts, [id]: text } });
  switch (key.kind) {
    case "escape":
    case "tab":
      return { type: "state", state: { ...s, focus: "rail" } };
    case "backspace":
      return { type: "state", state: withDraft(Array.from(draft).slice(0, -1).join("")) };
    case "char":
      return { type: "state", state: withDraft(draft + key.char) };
    case "enter": {
      const text = draft.trim();
      if (text.length === 0) return { type: "state", state: s };
      const sent = withDraft("", { scroll: 0 });
      const item = openAttention(s, id)[0];
      return item === undefined
        ? { type: "send", sessionId: id, text, state: sent }
        : { type: "answer", itemId: item.id, sessionId: id, text, state: sent };
    }
    default:
      return { type: "state", state: s };
  }
};
