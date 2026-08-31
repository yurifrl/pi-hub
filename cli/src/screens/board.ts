// cli/src/screens/board.ts — the bare `hub` attention board screen
// (docs/03-cli.md §hub (bare) + §Alt-screen lifecycle + §TTY degradation).
// The board is a viewer + inline inputs (docs/03 §bin Decision): every state
// change travels as a cmd frame through the context's cmd surface — the board
// never writes files and never mutates directly. Renderers produce frames;
// screen.ts owns the escape bytes.

import type { LogEntry, SessionRecord } from "@yurifrl/hub";
import type { CommandContext } from "../commands";
import { listOp, runOp } from "../hub_ops";
import { snapshotEnvelope } from "../envelope";
import { serializeEnvelope } from "../output";
import { failReply } from "../cmd_mutation_helpers";
import { ScreenBuffer, TerminalState, type Cell } from "../render/screen";
import { paintBoard, boardLines, type BoardFocus } from "../render/board";
import { streamLines, paintStreamLine, PIPED_HINT } from "../render/stream";
import { readKeys, type Key } from "../render/inputs";
import { detectColorLevel, hueIndex as libHueIndex } from "../render/theme";
import { applyKey, initialBoardState, type BoardEffect, type BoardState, type BoardSnapshot } from "./board_state";

const REFRESH_MS = 2000; // fallback tick (docs/03 §Refresh)

/** Readable body of one session — RUNNING fallback digest (docs/03 §Layout 3). */
const descriptionOf = (s: SessionRecord): string => s.description ?? s.title;

/** `l` overlay scope: all open sessions merged; `o`: one session. */
const overlayEntries = (files: CommandContext["files"], state: BoardState): LogEntry[] => {
  if (state.logSessionId !== null) return files.logEntries(state.logSessionId);
  const ids = Object.entries(state.snapshot.sessions)
    .filter(([, s]) => s.status === "open")
    .map(([id]) => id);
  return ids
    .flatMap((id) => files.logEntries(id))
    .sort((a, b) => a.t - b.t);
};

/** Merge map values into names, dropping empty strings. */
const mergeNames = (base: Record<string, string>, sessions: Record<string, Record<string, unknown>>): Record<string, string> => {
  const names = { ...base };
  for (const [id, rec] of Object.entries(sessions)) {
    const name = rec.name ?? rec.workerName;
    if (typeof name === "string" && name.length > 0) names[id] = name;
  }
  return names;
};

/** Machine snapshot (docs/03 §Machine modes): orientation + attention + running + idle. */
export const boardMachineData = (state: BoardState): Record<string, unknown> => ({
  orientation: state.orientation ?? null,
  attention: state.snapshot.attention,
  running: Object.entries(state.snapshot.sessions)
    .filter(([, s]) => s.phase === "working" || s.phase === "waiting")
    .map(([id, s]) => ({ id, name: state.names[id] ?? id.slice(0, 8), phase: s.phase, description: descriptionOf(s), age: s.lastActivity })),
  idle: Object.entries(state.snapshot.sessions)
    .filter(([, s]) => s.phase === "idle")
    .map(([id, s]) => ({ id, name: state.names[id] ?? id.slice(0, 8), phase: s.phase, age: s.lastActivity })),
});

/**
 * boardBody entry — the bare `hub` command (commands.ts boardBody). Returns
 * the process exit code: 0 for clean quits and one-shot degrades.
 */
export const runBoard = async (ctx: CommandContext): Promise<number> => {
  const format = ctx.policy.format;
  const stdoutTty = (ctx.io.stdout as { isTTY?: boolean }).isTTY === true;
  const stdinTty = (ctx.io.stdin as { isTTY?: boolean }).isTTY === true;

  // ---- first snapshot (attention list op) --------------------------------
  // One-shot degrades (pipe stdout, machine modes) render instead of failing
  // when the hub is down — they are snapshots, not session-bound mutations.
  const first = await listOp(ctx);
  if (!first.ok && stdoutTty) failReply(ctx, first);
  const initialReply = (first.ok ? first.result : {}) as BoardSnapshot;
  let state = initialBoardState(initialReply);

  // ---- machine modes: one static snapshot envelope, never alt-screen -----
  if (format !== "human") {
    return emitSnapshot(ctx, state);
  }

  // ---- pipe stdout: one static human frame + muted hint, exit 0 ----------
  if (!stdoutTty) {
    const model = {
      snapshot: state.snapshot,
      focus: { slot: null, drafts: new Map<string, string>(), input: null },
      names: state.names,
      width: 0,
      inputsEnabled: false,
      ...(state.orientation !== undefined ? { orientation: state.orientation } : {}),
    };
    for (const line of boardLines(model, libHueIndex, Date.now())) {
      for (const [text] of line.segs) ctx.io.stdout.write(text + "\n");
    }
    ctx.io.stdout.write(`(run hub in a terminal for live view)\n`);
    return 0;
  }

  // ---- interactive alt-screen board --------------------------------------
  const emit = (s: string): void => {
    ctx.io.stdout.write(s);
  };
  const setRaw = (on: boolean): void => {
    const tty = ctx.io.stdin as unknown as { setRawMode?: (on: boolean) => void };
    tty.setRawMode?.(on);
  };
  const terminal = new TerminalState(emit, setRaw);
  const buffer = new ScreenBuffer(emit, detectColorLevel(process.env, stdoutTty, ctx.config.color));
  const hueIndex = libHueIndex;

  // loop-local runtime state
  let quitCode: number | null = null;
  let width = 0;
  let rows0: number | null = null;
  let now = Date.now();

  const paint = (): void => {
    if (state.view === "log") {
      const rows = Math.max(1, (rows0 ?? 24) - 1);
      const lines = streamLines(overlayEntries(ctx.files, state), hueIndex, width > 0 ? width : 0);
      const cells: Cell[][] = [];
      const room = width > 0 ? Math.max(1, rows) : lines.length;
      for (const line of lines.slice(Math.max(0, lines.length - room))) cells.push(paintStreamLine(line));
      buffer.write(cells);
      return;
    }
    const focus: BoardFocus = { slot: state.focus, drafts: state.drafts, input: state.input, cursor: state.cursor };
    const inputsEnabled = stdinTty;
    const model = {
      snapshot: state.snapshot,
      focus,
      names: state.names,
      width,
      inputsEnabled,
      ...(state.orientation !== undefined ? { orientation: state.orientation } : {}),
    };
    buffer.write(paintBoard(model, hueIndex, now));
  };

  /** One cmd round-trip per effect; failures never exit — the board is a viewer (docs/03 §watch degrade rationale, bare board likewise). */
  const runEffect = async (effect: BoardEffect): Promise<void> => {
    if (effect === null) return;
    switch (effect.type) {
      case "answer":
        await runOp(ctx, "answer", { id: effect.id, text: effect.text });
        return;
      case "assign":
        await runOp(ctx, "assign", { id: effect.sessionId, task: effect.task });
        return;
      case "dismiss":
        await runOp(ctx, "attention", { action: "dismiss", id: effect.id });
        return;
      case "open-log":
      case "close-log":
        return;
      case "quit":
        quitCode = 0;
        return;
    }
  };

  /** Refresh the snapshot; a failed re-list renders as a stale frame (viewer never crashes). */
  const refresh = async (): Promise<void> => {
    const listing = await listOp(ctx);
    if (!listing.ok) return;
    const reply = listing.result as BoardSnapshot;
    const next = initialBoardState(reply);
    state = {
      ...next,
      focus: state.focus,
      input: state.input,
      cursor: state.cursor,
      drafts: state.drafts,
      view: state.view,
      logSessionId: state.logSessionId,
    };
    state.names = mergeNames(next.names, reply.sessions as unknown as Record<string, Record<string, unknown>>);
  };

  terminal.enter();
  {
    const rows = (ctx.io.stdout as unknown as { rows?: number | null }).rows;
    rows0 = typeof rows === "number" && rows > 0 ? rows : null;
    const cols = (ctx.io.stdout as unknown as { columns?: number | null }).columns;
    width = typeof cols === "number" && cols > 0 ? cols : 0;
    buffer.resize(width, rows0 ?? 24);
  }
  await refresh();
  paint();
  buffer.flush();

  // 2s fallback tick — re-issues the attention cmd and re-reads (docs/03 §Refresh)
  const tick = setInterval(() => {
    now = Date.now();
    void refresh();
  }, REFRESH_MS);

  // exit hook: restore the terminal on every exit path (docs/03 §Alt-screen lifecycle)
  const cleanup = (): void => {
    clearInterval(tick);
    terminal.restore();
    buffer.leaveAlt();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  try {
    const keys = stdinTty ? readKeys(ctx.io.stdin, setRaw) : null;
    while (quitCode === null) {
      const pull = async (): Promise<Key | null> => {
        if (keys === null) await new Promise<never>(() => {});
        const r = await keys![Symbol.asyncIterator]().next();
        return r.done ? null : r.value;
      };
      const key = await pull();
      if (key === null) break; // stdin EOF
      const { state: next, effect } = applyKey(state, key);
      state = next;
      if (effect !== null) await runEffect(effect);
      if (quitCode !== null) break;
      if (effect !== null && effect.type !== "quit") {
        // mutations re-list (item leaves the board on the next frame, docs/06 answer/assign flows)
        await refresh();
      }
      now = Date.now();
      paint();
      buffer.flush();
    }
    cleanup();
    return 0;
  } catch (e) {
    cleanup();
    throw e;
  }
};

/** Emit the machine snapshot envelope and pin exit 0 (docs/03 §Output policies). */
const emitSnapshot = (ctx: CommandContext, state: BoardState): number => {
  // bodies touch the terminal only through ctx.io (io.ts contract) — never process.stdout
  const format = ctx.policy.format === "human" ? "json" : ctx.policy.format;
  ctx.io.stdout.write(serializeEnvelope(snapshotEnvelope(boardMachineData(state)), format));
  return 0;
};

/** Re-export for tests asserting the piped frame's muted hint. */
export { PIPED_HINT };
