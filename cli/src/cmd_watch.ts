// cli/src/cmd_watch.ts — `hub watch` host (docs/03-cli.md §hub watch): the
// alt-screen split console. Composition only — the pure state machine lives
// in screens/watch.ts, painters in render/, the feed in hub_events.ts, the
// tail in log_follow.ts. Host wiring per docs/03 §Rendering: EventBus push
// frames, every reply frame, the 2s fallback tick, and keypresses trigger
// re-render; frames pass through the diffing ScreenBuffer (zero-diff writes
// nothing). q / ctrl-c restore the terminal and exit 0. Piped stdout renders
// one static frame + muted hint and exits 0 (docs/03 §TTY degradation).

import type { LogEntry, StatusFile } from "@yurifrl/hub";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { runOp } from "./hub_ops";
import { hubSubscribe, type HubFeed } from "./hub_events";
import { ScreenBuffer, padRow, textRow, TerminalState } from "./render/screen";
import { hueIndex, detectColorLevel } from "./render/theme";
import type { BoardLine } from "./render/board";
import { paintStreamLine, PIPED_HINT } from "./render/stream";
import { colorLevelFor, renderRow, mutedRow } from "./log_render";
import { makeLogFollower, nodeFollowIo, type FollowIo } from "./log_follow";
import {
  applyEvent,
  applyKey,
  dismissFocused,
  initialWatchState,
  moveRailFocus,
  paneLines,
  railLines,
  startFirstAnswer,
  type WatchState,
} from "./screens/watch";
import { readKeys, type Key } from "./render/inputs";
import type { Cell } from "./render/screen";

const FALLBACK_TICK_MS = 2000; // docs/03 §Refresh fallback tick
const LOG_TICK_MS = 250;

export const cmdWatch = async (ctx: CommandContext): Promise<void> => {
  const format = ctx.policy.format;

  // machine modes: static snapshot (attention items + last 50 log lines),
  // no alt-screen (docs/03 §hub watch Machine modes)
  if (format !== "human") {
    const status = ctx.files.status();
    const entries = watchSnapshotEntries(ctx);
    return emitResult(() => {
      ctx.io.stdout.write(
        JSON.stringify({
          type: "snapshot",
          data: {
            attention: status?.attention ?? [],
            sessions: status?.sessions ?? {},
            entries: entries.slice(-50),
          },
        }) + "\n",
      );
    });
  }

  const stdoutIsTty = ctx.io.stdout === process.stdout
    ? process.stdout.isTTY === true
    : (ctx.io.stdout as { isTTY?: boolean }).isTTY === true;
  const status = ctx.files.status();

  // piped stdout → one static frame + muted hint, exit 0 (docs/03 §TTY degradation)
  if (!stdoutIsTty) {
    const level = colorLevelFor(ctx);
    return emitResult(() => {
      const s = initialWatchState(status);
      for (const line of railLines(s, 0, Date.now())) {
        ctx.io.stdout.write(line.text + "\n");
      }
      for (const l of paneLines({ ...s, entries: watchSnapshotEntries(ctx) }, hueIndex)) {
        ctx.io.stdout.write(renderRow(paintStreamLine(l), level) + "\n");
      }
      ctx.io.stdout.write(renderRow(mutedRow(PIPED_HINT), "plain") + "\n");
    });
  }

  return runWatchScreen(ctx, status);
};

/** Log tail material for snapshots/static frames: merged entries from open sessions' files. */
const watchSnapshotEntries = (ctx: CommandContext): LogEntry[] => {
  const status = ctx.files.status();
  const out: LogEntry[] = [];
  if (status === null) return out;
  for (const id of Object.keys(status.sessions)) {
    if (status.sessions[id]!.status !== "open") continue;
    out.push(...ctx.files.logEntries(id));
  }
  out.sort((a, b) => a.t - b.t);
  return out;
};

/**
 * The interactive watch loop. Wiring: feed events + fallback tick + log tail
 * feed state; every mutation schedules one coalesced paint (docs/03
 * §Re-render triggers: batch coalesce to one paint per tick — ScreenBuffer
 * does the diff batching).
 */
const runWatchScreen = async (ctx: CommandContext, status0: StatusFile | null): Promise<void> => {
  const io = ctx.io;
  const level = detectColorLevel(process.env, true, ctx.policy.color);
  const buffer = new ScreenBuffer((s) => io.stdout.write(s), level);
  const term = new TerminalState(
    (s) => io.stdout.write(s),
    (on) => (io.stdin as { setRawMode?: (on: boolean) => void }).setRawMode?.(on),
  );

  let state = initialWatchState(status0);
  state = { ...state, orientation: status0?.digest };

  let quit = false;
  const restore = (): void => {
    term.restore();
    buffer.leaveAlt();
  };
  const paint = (): void => {
    paintWatch(ctx, buffer, state);
  };

  const cols = (): number => {
    const c = process.stdout.columns ?? 80;
    return c > 0 ? c | 0 : 80;
  };
  const rows = (): number => {
    const r = process.stdout.rows ?? 24;
    return r > 0 ? r | 0 : 24;
  };
  const resize = (): void => buffer.resize(cols(), rows());

  term.enter();
  resize();
  buffer.enterAlt();
  paint();
  buffer.flush();

  // ---- event feed (EventBus push frames over the socket, docs/03 §Refresh) ----
  const feedRef: { current: HubFeed | null } = { current: null };
  const unsubRef: { current: (() => void) | null } = { current: null };
  const connectFeed = async (): Promise<void> => {
    const res = await hubSubscribe(ctx.config.sock);
    if (!res.ok) {
      state = { ...state, offline: true };
      paint();
      void buffer.flush();
      return;
    }
    feedRef.current = res.feed;
    state = { ...state, offline: false };
    unsubRef.current = res.feed.on((evt) => {
      state = applyEvent(state, evt);
      schedulePaint();
    });
    res.feed.onClose(() => {
      state = { ...state, offline: true };
      schedulePaint();
    });
    paint();
    void buffer.flush();
  };
  void connectFeed();

  // ---- coalesced repaint (docs/03: batch coalesce, one paint per tick) ----
  let paintQueued = false;
  const schedulePaint = (): void => {
    if (paintQueued) return;
    paintQueued = true;
    setImmediate(() => {
      paintQueued = false;
      if (quit) return;
      paint();
      buffer.flush();
    });
  };

  // ---- fallback tick: re-issue attention/list + re-read status.json (docs/03 §Refresh) ----
  const refresh = async (): Promise<void> => {
    const listing = await runOp(ctx, "list", {});
    if (listing.ok) {
      const data = listing.result as Partial<StatusFile>;
      state = {
        ...state,
        offline: false,
        status: {
          version: data.version ?? 1,
          startedAt: data.startedAt ?? new Date(0).toISOString(),
          pid: data.pid ?? 0,
          nextAttentionId: data.nextAttentionId ?? 0,
          sessions: data.sessions ?? {},
          attention: data.attention ?? [],
          archived: data.archived ?? [],
          ...(data.digest !== undefined ? { digest: data.digest } : {}),
          ...(data.agentSession !== undefined ? { agentSession: data.agentSession } : {}),
        },
      };
      state = { ...state, orientation: (listing.result as { digest?: string }).digest };
    } else if (feedRef.current === null) {
      state = { ...state, offline: true };
    }
    // local status.json still feeds the log pane's open-session set offline
    const disk = ctx.files.status();
    if (disk !== null) {
      state = { ...state, status: state.status ?? disk };
    }
    schedulePaint();
  };
  void refresh();
  const fallbackTimer = setInterval(() => void refresh(), FALLBACK_TICK_MS);

  // ---- log tail: pinned → that session's file; unpinned → all open sessions ----
  const followIo: FollowIo = nodeFollowIo();
  const followers = new Map<string, ReturnType<typeof makeLogFollower>>();
  const tailBuffer: { entries: LogEntry[] } = { entries: [] };
  const tailTimer = setInterval(() => {
    const ids = state.pin !== null ? [state.pin] : Object.keys(state.status?.sessions ?? {}).filter((id) => state.status?.sessions[id]?.status === "open");
    const fresh: LogEntry[] = [];
    for (const id of ids) {
      let f = followers.get(id);
      if (f === undefined) {
        f = makeLogFollower(followIo, `${ctx.config.dataRoot}/logs/${id}.jsonl`);
        followers.set(id, f);
      }
      const step = f.step();
      if (step.entries.length > 0) fresh.push(...step.entries);
    }
    if (fresh.length === 0) return;
    fresh.sort((a, b) => a.t - b.t);
    let entries = [...tailBuffer.entries, ...fresh];
    if (entries.length > 500) entries = entries.slice(entries.length - 500);
    tailBuffer.entries = entries;
    state = { ...state, entries };
    schedulePaint();
  }, LOG_TICK_MS);

  // ---- keys ----
  const stdin = io.stdin as NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void };
  const keys = readKeys(stdin, (on) => stdin.setRawMode?.(on));

  for await (const key of keys) {
    if (key.kind === "ignore") continue;
    if (key.kind === "up") {
      state = moveRailFocus(state, -1);
      schedulePaint();
      continue;
    }
    if (key.kind === "down") {
      state = moveRailFocus(state, 1);
      schedulePaint();
      continue;
    }
    if (key.kind === "char" && key.char === "d" && !state.filterOpen && state.focus.input === null) {
      const action = dismissFocused(state);
      if (action.type === "dismiss") {
        void cmdDismiss(ctx, action.itemId).then((err) => {
          state = { ...state, railError: err };
          schedulePaint();
        });
      }
      continue;
    }
    const action = applyKey(state, key as Key, Object.keys(state.status?.sessions ?? {}).length);
    if (action.type === "quit") {
      quit = true;
      break;
    }
    if (action.type === "answer") {
      void cmdAnswerItem(ctx, action.itemId, action.text).then((err) => {
        state = { ...state, railError: err };
        schedulePaint();
      });
    } else if (action.type === "state") {
      state = action.state;
    }
    if (action.type === "state" && action.state.focus.input === "" && action.state.focus.slot !== null) {
      // typing started on a slot — keep painting the cursor line
      schedulePaint();
    }
    schedulePaint();
    if (key.kind === "char" && key.char === "a" && !state.filterOpen) {
      // `a` opens the first attention item's answer input (docs/03 task spec)
      state = startFirstAnswer(state);
      schedulePaint();
    }
  }

  // ---- restore terminal on every exit path (docs/03 §Alt-screen lifecycle) ----
  restore();
  clearInterval(fallbackTimer);
  clearInterval(tailTimer);
  unsubRef.current?.();
  feedRef.current?.close();
  process.exitCode = 0;
};

/** cmd frame answer {id, text}; returns an inline rail error or null. */
const cmdAnswerItem = async (
  ctx: CommandContext,
  itemId: string,
  text: string,
): Promise<string | null> => {
  const reply = await runOp(ctx, "answer", { id: itemId, text });
  if (reply.ok) return null;
  // offline / refused → inline err line in the rail, never a process exit (docs/03)
  return `${reply.code}: ${reply.message}`;
};

/** cmd frame attention {action:"dismiss", id}. */
const cmdDismiss = async (ctx: CommandContext, itemId: string): Promise<string | null> => {
  const reply = await runOp(ctx, "attention", { action: "dismiss", id: itemId });
  return reply.ok ? null : `${reply.code}: ${reply.message}`;
};

/** Compose one watch frame: header + rail + log pane + footer (docs/03 sketch 3). */
const paintWatch = (ctx: CommandContext, buffer: ScreenBuffer, state: WatchState): void => {
  void ctx;
  // guard: a non-sized stdout (redirected/pty-less) falls back to 80×24
  const cols = (process.stdout.columns ?? 80) > 0 ? (process.stdout.columns ?? 80) | 0 : 80;
  const totalRows = (process.stdout.rows ?? 24) > 0 ? (process.stdout.rows ?? 24) | 0 : 24;

  const header = ` hub watch · ${Object.keys(state.status?.sessions ?? {}).length} sessions · ${state.pin === null ? "no pin" : `pin ${state.pin.slice(0, 8)}`} · filter ${state.filterOpen ? `▏${state.filter}` : state.filter.length > 0 ? state.filter : "—"}`;
  const footer = `keys l log-only · a attention-only · 1-9 pin · / filter · q quit`;
  const railRows = state.mode === "log-only" ? 0 : Math.max(3, Math.floor(totalRows / 3));
  const paneRows = state.mode === "attention-only" ? 0 : totalRows - railRows - 2;

  const out: CellGrid = [];
  out.push(textRow(header.slice(0, cols)));

  if (railRows > 0) {
    const lines = railLines(state, cols, Date.now());
    for (let i = 0; i < railRows; i++) {
      const line = lines[i];
      if (line === undefined) {
        out.push([]);
        continue;
      }
      const cells = paintBoardCells(line);
      out.push(padRow(cells, cols));
    }
  }

  if (paneRows > 0) {
    const lines = paneLines(state, hueIndex, cols);
    const painted = lines.slice(Math.max(0, lines.length - paneRows));
    for (let i = 0; i < paneRows; i++) {
      const line = painted[i];
      out.push(line === undefined ? [] : padRow(paintStreamLine(line), cols));
    }
  }

  out.push(textRow(footer.slice(0, cols)));
  buffer.write(out);
};

type CellGrid = Cell[][];

/** board line model → cells (docs/03 §Screen buffer: board.ts paints; we encode). */
const paintBoardCells = (line: BoardLine): Cell[] => {
  const cells: Cell[] = [];
  if (line.hueSessionId !== undefined) {
    // two-cell hue bar per docs/03 §Session hue
    const h = hueIndex(line.hueSessionId);
    cells.push({ ch: "▎", fg: h }, { ch: "▎", fg: h });
  }
  for (const [text, style] of line.segs) {
    for (const ch of text) cells.push({ ch, ...(style !== undefined ? { fg: style } : {}) });
  }
  return cells;
};