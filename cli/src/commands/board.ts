// hub (bare) / hub board — the attention board (spec §hub (bare)).
// Machine modes print one snapshot envelope; a piped human run prints one static frame;
// a TTY run is the live OpenTUI loop.

import { createCliRenderer } from "@opentui/core";
import type { RegisterCommand } from "../context";
import { emitSnapshot } from "../output";
import { isInteractive } from "../prompt";
import { linesText, makePalette, paintLines } from "../tui/colors";
import { decodeKey } from "../tui/keys";
import { boardDataOf, boardKey, boardLines, boardSnapshot, initialBoardState, type BoardAction, type BoardData, type BoardState } from "../tui/rows";
import type { CliContext } from "../context";

const REFRESH_MS = 2000;

const STATIC_COLS = 80;
const STATIC_ROWS = 24;

const runLive = async (ctx: CliContext): Promise<void> => {
  const client = await ctx.connect({ subscribe: true });
  const palette = makePalette(ctx.policy.color);
  let data: BoardData;
  try {
    data = boardDataOf(await ctx.call("list", {}));
  } catch (e) {
    client.close();
    throw e;
  }
  let state: BoardState = initialBoardState;
  let lastText = "";

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    exitSignals: ["SIGINT", "SIGTERM"],
    useMouse: false,
    backgroundColor: palette.base,
  });
  const done = Promise.withResolvers<void>();
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    if (!renderer.isDestroyed) renderer.destroy();
    client.close();
    done.resolve();
  };

  // pushed events can burst; one fetch in flight, one queued rerun
  let busy = false;
  let dirty = false;
  const refresh = async (): Promise<void> => {
    if (finished) return;
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    try {
      do {
        dirty = false;
        const r = await client.cmd("list", {});
        if (r.ok) {
          data = boardDataOf(r.value);
          state = { ...state, focus: Math.min(state.focus, Math.max(0, data.attention.length + data.idle.length - 1)) };
          if (!finished && !renderer.isDestroyed) renderer.requestRender();
        }
      } while (dirty && !finished);
    } finally {
      busy = false;
    }
  };

  const perform = async (action: BoardAction): Promise<void> => {
    switch (action.kind) {
      case "quit":
        finish();
        return;
      case "answer":
        await client.cmd("answer", { id: action.id, text: action.text });
        break;
      case "assign":
        await client.cmd("assign", { id: action.id, task: action.text });
        break;
      case "dismiss":
        await client.cmd("attention", { action: "dismiss", id: action.id });
        break;
      // `l` (log) and `o` (open) belong to other surfaces: no-op here.
      default:
        return;
    }
    await refresh();
  };

  renderer.addPostProcessFn((buffer) => {
    const lines = boardLines(state, data, buffer.width, buffer.height, Date.now());
    // Unchanged frame: leave the buffer as drawn last time (same text => same paint).
    lastText = linesText(lines);
    paintLines(buffer, lines, palette);
  });
  renderer.keyInput.on("keypress", (ev) => {
    const step = boardKey(state, decodeKey(ev), data);
    state = step.state;
    renderer.requestRender();
    void perform(step.action).catch(() => {
      // a failed action leaves the board as is; the next refresh shows the truth
    });
  });
  renderer.on("destroy", finish);
  client.onEvent(() => void refresh());
  client.onClose(finish);
  // relative times ("3m") age without events: the tick repaints only when the frame text changes
  timer = setInterval(() => {
    const next = linesText(boardLines(state, data, renderer.width, renderer.height, Date.now()));
    if (next !== lastText && !renderer.isDestroyed) renderer.requestRender();
  }, REFRESH_MS);
  renderer.requestRender();
  await done.promise;
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("board", { isDefault: true })
    .description("attention board: what needs you (default)")
    .action(async () => {
      const policy = ctx.policy;
      const data = boardDataOf(await ctx.call("list", {}));
      if (policy.machine) {
        emitSnapshot(policy, boardSnapshot(data));
        return;
      }
      if (!isInteractive(false)) {
        const cols = process.stdout.columns ?? STATIC_COLS;
        const rows = process.stdout.rows ?? STATIC_ROWS;
        const text = linesText(boardLines(initialBoardState, data, cols, rows, Date.now(), true));
        process.stdout.write(`${text}\n\nrun hub in a terminal for live view\n`);
        return;
      }
      await runLive(ctx);
    });
};
