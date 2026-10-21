// cli/src/cmd_watch.ts — `hub watch` host (docs/03-cli.md §hub watch): the
// alt-screen chat console. Composition only — the pure state machine lives in
// screens/watch.ts, the painter in render/watch_view.ts, the feed in
// hub_events.ts, the tails in log_follow.ts. Wiring per docs/03 §Rendering:
// EventBus push frames, the 2s fallback tick, the log tails and keypresses all
// mutate state and schedule one coalesced paint; frames pass through the
// diffing ScreenBuffer (zero-diff writes nothing). q / ctrl-c restore the
// terminal and exit 0. Piped stdout renders one static frame + muted hint and
// exits 0 (docs/03 §TTY degradation).

import type { LogEntry, StatusFile } from "@yurifrl/hub";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { runOp } from "./hub_ops";
import { hubSubscribe, type HubFeed } from "./hub_events";
import { ScreenBuffer, TerminalState } from "./render/screen";
import { detectColorLevel } from "./render/theme";
import { PIPED_HINT } from "./render/stream";
import { paintWatchView, plainSnapshot } from "./render/watch_view";
import { mutedRow } from "./log_render";
import { renderRow } from "./log_render";
import { makeLogFollower, nodeFollowIo } from "./log_follow";
import { readKeys } from "./render/inputs";
import {
  applyEvent,
  applyKey,
  ensureSelection,
  initialWatchState,
  mergeEntries,
  MAX_EXTRAS,
  railExtras,
  railIds,
  sessionName,
  type Notice,
  type ViewMetrics,
} from "./screens/watch";

const FALLBACK_TICK_MS = 2000; // docs/03 §Refresh fallback tick
const LOG_TICK_MS = 250;

export const cmdWatch = async (ctx: CommandContext): Promise<void> => {
  // machine modes: static snapshot (attention items + last 50 log lines),
  // no alt-screen (docs/03 §hub watch Machine modes)
  if (ctx.policy.format !== "human") {
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

  const stdoutIsTty = (ctx.io.stdout as { isTTY?: boolean }).isTTY === true || (ctx.io.stdout === process.stdout && process.stdout.isTTY === true);
  const status = ctx.files.status();

  // piped stdout → one static frame + muted hint, exit 0 (docs/03 §TTY degradation)
  if (!stdoutIsTty) {
    return emitResult(() => {
      const extra = railExtras(status, ctx.files.recentLogIds(MAX_EXTRAS));
      let s = initialWatchState(status, extra);
      for (const id of railIds(status, extra)) s = mergeEntries(s, id, ctx.files.logEntries(id), false);
      for (const line of plainSnapshot(s, 100)) ctx.io.stdout.write(line + "\n");
      ctx.io.stdout.write(renderRow(mutedRow(PIPED_HINT), "plain") + "\n");
    });
  }

  return runWatchScreen(ctx, status);
};

/** Log tail material for machine snapshots: merged entries from open sessions' files. */
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

const termSize = (): { cols: number; rows: number } => {
  const c = process.stdout.columns ?? 80;
  const r = process.stdout.rows ?? 24;
  return { cols: c > 0 ? c | 0 : 80, rows: r > 0 ? r | 0 : 24 };
};

/**
 * The interactive watch loop. Every mutation schedules one coalesced paint
 * (docs/03 §Re-render triggers: batch coalesce to one paint per tick —
 * ScreenBuffer does the diff batching).
 */
const runWatchScreen = async (ctx: CommandContext, status0: StatusFile | null): Promise<void> => {
  const io = ctx.io;
  const level = detectColorLevel(process.env, true, ctx.policy.color);
  const buffer = new ScreenBuffer((s) => io.stdout.write(s), level);
  const stdin = io.stdin;
  const term = new TerminalState(
    (s) => io.stdout.write(s),
    (on) => stdin.setRawMode?.(on),
  );

  const extras0 = railExtras(status0, ctx.files.recentLogIds(MAX_EXTRAS));
  let state = initialWatchState(status0, extras0);
  let view: ViewMetrics = { pageRows: 10, maxScroll: 0 };
  let quit = false;

  const paint = (): void => {
    const { cols, rows } = termSize();
    buffer.resize(cols, rows);
    const frame = paintWatchView(state, cols, rows, Date.now());
    view = frame.view;
    buffer.write(frame.rows);
  };

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

  const notify = (notice: Notice | null): void => {
    state = { ...state, notice };
    schedulePaint();
  };

  term.enter();
  buffer.enterAlt();
  paint();
  buffer.flush();

  // ---- event feed (EventBus push frames over the socket, docs/03 §Refresh) ----
  const feedRef: { current: HubFeed | null } = { current: null };
  const unsubRef: { current: (() => void) | null } = { current: null };
  void (async () => {
    const res = await hubSubscribe(ctx.config.sock);
    if (quit) {
      if (res.ok) res.feed.close();
      return;
    }
    if (!res.ok) {
      state = { ...state, offline: true };
      schedulePaint();
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
    schedulePaint();
  })();

  // ---- fallback tick: re-issue list; offline → fall back to status.json on disk ----
  const refresh = async (): Promise<void> => {
    const listing = await runOp(ctx, "list", {});
    if (quit) return;
    if (listing.ok) {
      const data = listing.result as Partial<StatusFile>;
      const status = {
        version: data.version ?? 1,
        startedAt: data.startedAt ?? new Date(0).toISOString(),
        pid: data.pid ?? 0,
        nextAttentionId: data.nextAttentionId ?? 0,
        sessions: data.sessions ?? {},
        attention: data.attention ?? [],
        archived: data.archived ?? [],
        ...(data.digest !== undefined ? { digest: data.digest } : {}),
        ...(data.agentSession !== undefined ? { agentSession: data.agentSession } : {}),
      };
      // Session set changed → re-scan archived + recent log files so new omp
      // sessions appear in the rail (docs/03 §watch rail).
      const extras =
        status.digest !== state.orientation ? railExtras(status, ctx.files.recentLogIds(MAX_EXTRAS)) : state.extras;
      state = { ...state, offline: false, orientation: data.digest, status, extras };
    } else {
      state = { ...state, offline: true };
      const disk = ctx.files.status();
      if (disk !== null) state = { ...state, status: disk };
    }
    state = ensureSelection(state, state.extras);
    schedulePaint();
  };
  void refresh();
  const fallbackTimer = setInterval(() => void refresh(), FALLBACK_TICK_MS);

  // ---- log tails: one follower per session so unread counts keep moving ----
  const followIo = nodeFollowIo();
  const followers = new Map<string, ReturnType<typeof makeLogFollower>>();
  const seenFirst = new Set<string>();
  const tailTimer = setInterval(() => {
    let next = state;
    // Extras (archived / log-only) get no followers — their chat is read once,
    // lazily, when selected (docs/03 §watch rail: rail-only until visited).
    const selected = state.selected;
    if (selected !== null && state.entries[selected] === undefined && !followers.has(selected) &&
        state.status?.sessions[selected] === undefined) {
      next = mergeEntries(next, selected, ctx.files.logEntries(selected), false);
    }
    for (const id of railIds(state.status)) {
      let f = followers.get(id);
      if (f === undefined) {
        f = makeLogFollower(followIo, `${ctx.config.dataRoot}/logs/${id}.jsonl`);
        followers.set(id, f);
      }
      const step = f.step();
      if (step.rotated || step.truncated) next = { ...next, entries: { ...next.entries, [id]: [] } };
      if (step.entries.length === 0) continue;
      const live = seenFirst.has(id);
      seenFirst.add(id);
      next = mergeEntries(next, id, step.entries, live);
    }
    // sessions that left the map drop their followers and history
    const open = new Set(railIds(state.status));
    for (const id of [...followers.keys()]) {
      if (!open.has(id)) {
        followers.delete(id);
        seenFirst.delete(id);
      }
    }
    if (next !== state) {
      state = next;
      schedulePaint();
    }
  }, LOG_TICK_MS);

  // ---- keys ----
  for await (const key of readKeys(stdin, (on) => stdin.setRawMode?.(on))) {
    if (key.kind === "ignore") continue;
    const action = applyKey(state, key, view);
    if (action.type === "quit") {
      quit = true;
      break;
    }
    state = action.state;
    schedulePaint();
    const name = (id: string): string => sessionName(id, state.status?.sessions[id]);
    if (action.type === "send") {
      void runOp(ctx, "send", { target: action.sessionId, text: action.text }).then((r) =>
        notify(r.ok ? { text: `✓ sent to ${name(action.sessionId)}`, tone: "ok" } : { text: `${r.code}: ${r.message}`, tone: "err" }),
      );
    } else if (action.type === "answer") {
      void runOp(ctx, "answer", { id: action.itemId, text: action.text }).then((r) =>
        notify(r.ok ? { text: `✓ answered ${name(action.sessionId)}`, tone: "ok" } : { text: `${r.code}: ${r.message}`, tone: "err" }),
      );
    } else if (action.type === "dismiss") {
      void runOp(ctx, "attention", { action: "dismiss", id: action.itemId }).then((r) =>
        notify(r.ok ? { text: "✓ dismissed", tone: "ok" } : { text: `${r.code}: ${r.message}`, tone: "err" }),
      );
    }
  }

  // ---- restore terminal on every exit path (docs/03 §Alt-screen lifecycle) ----
  term.restore();
  buffer.leaveAlt();
  clearInterval(fallbackTimer);
  clearInterval(tailTimer);
  unsubRef.current?.();
  feedRef.current?.close();
  process.exitCode = 0;
};
