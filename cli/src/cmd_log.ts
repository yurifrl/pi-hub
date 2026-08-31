// cli/src/cmd_log.ts — `hub log [-f] [id]` (docs/03-cli.md §Subcommands log):
// read-only over logs/<id>.jsonl, no socket (docs/03 §bin: never exits 2).
// `-f` follows appended lines in a TTY — scrolling lines with tail
// semantics, no alt-screen, ctrl-c exits 0 (docs/03 §Alt-screen lifecycle).
// Piped stdout renders one static frame + muted hint and exits 0 (docs/03
// §TTY degradation). Streaming rows: --ndjson one envelope line per entry
// (streams forever with -f); --json + -f → usage 1; --json one snapshot.

import type { LogEntry } from "@yurifrl/hub";
import { snapshotEnvelope } from "./envelope";
import { serializeEnvelope } from "./output";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith } from "./cmd_mutation_helpers";
import { hueIndex } from "./render/theme";
import { paintStreamLine, streamLines, PIPED_HINT } from "./render/stream";
import { colorLevelFor, renderRow, mutedRow } from "./log_render";
import { makeLogFollower, nodeFollowIo } from "./log_follow";
import { openSessionsFromStatus, resolveIdArg } from "./log_select";
import { readKeys } from "./render/inputs";

const FOLLOW_POLL_MS = 250;
/** Plain dumps and static frames show the tail (docs/03 §log tail semantics). */
const PLAIN_TAIL = 200;

/** Human rows for entries: hue-bar stream lines at the invocation's color level. */
const entryRows = (entries: LogEntry[], level: ReturnType<typeof colorLevelFor>): string[] =>
  streamLines(entries, hueIndex).map((l) => renderRow(paintStreamLine(l), level));

/** Interrupt stream over raw-mode stdin; resolves when the user quits. */
const quitKeys = async (stdin: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void }): Promise<"quit"> => {
  const keys = readKeys(stdin, (on) => stdin.setRawMode?.(on));
  for await (const k of keys) {
    if (k.kind === "ctrl-c") break;
    if (k.kind === "char" && k.char === "q") break;
  }
  stdin.setRawMode?.(false);
  return "quit";
};

export const cmdLog = async (ctx: CommandContext, follow: boolean, id: string | undefined): Promise<void> => {
  const format = ctx.policy.format;

  // flag matrix (docs/03 §log): --json with -f → usage 1
  if (format === "json" && follow) return failWith(ctx, "usage", "log: --json does not stream; use --ndjson with -f");

  const status = ctx.files.status();
  const open = openSessionsFromStatus(status);
  const sessionId = await resolveIdArg(ctx, open, id, "log");
  const entries = ctx.files.logEntries(sessionId);

  // session open but log file absent → exit 1 with hint (docs/03 §log errors)
  if (status !== null && status.sessions[sessionId] !== undefined && entries.length === 0) {
    return failWith(ctx, "not_found", `log: no entries yet for ${sessionId.slice(0, 8)}`);
  }

  // ---- --ndjson: one envelope line per entry; with -f streams forever ----
  if (format === "ndjson") {
    emitResult(() => {
      for (const e of entries) ctx.io.stdout.write(serializeEnvelope(snapshotEnvelope(e), "ndjson"));
    });
    if (!follow) return;
    return runFollow(ctx, (step) => {
      for (const e of step.entries) ctx.io.stdout.write(serializeEnvelope(snapshotEnvelope(e), "ndjson"));
    }, sessionId);
  }

  // ---- --json: one snapshot envelope {sessionId, entries} ----
  if (format === "json") {
    emitResult(() => {
      ctx.io.stdout.write(serializeEnvelope(snapshotEnvelope({ sessionId, entries }), "json"));
    });
    return;
  }

  // ---- human ----
  const level = colorLevelFor(ctx);
  const stdoutIsTty = ctx.io.stdout === process.stdout ? process.stdout.isTTY === true : false;

  if (follow) {
    // piped stdout → one static frame + muted hint, exit 0 (docs/03 §TTY degradation)
    if (!stdoutIsTty) {
      return emitResult(() => {
        for (const row of entryRows(entries.slice(-PLAIN_TAIL), level)) ctx.io.stdout.write(row + "\n");
        ctx.io.stdout.write(renderRow(mutedRow(PIPED_HINT), "plain") + "\n");
      });
    }
    // TTY: scrolling lines with tail semantics — no alt-screen, no buffer
    emitResult(() => {
      for (const row of entryRows(entries.slice(-PLAIN_TAIL), level)) ctx.io.stdout.write(row + "\n");
    });
    const stdin = ctx.io.stdin as NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void };
    const follower = makeLogFollower(nodeFollowIo(), logPath(ctx, sessionId));
    const quit = quitKeys(stdin).then(
      () => true,
      () => false,
    );
    await followLoop(follower, FOLLOW_POLL_MS, (step) => {
      for (const row of entryRows(step.entries, level)) ctx.io.stdout.write(row + "\n");
    }, quit);
    return;
  }

  emitResult(() => {
    const tail = entries.slice(-PLAIN_TAIL);
    if (tail.length === 0) {
      ctx.io.stdout.write("(no entries yet)\n");
      return;
    }
    for (const row of entryRows(tail, level)) ctx.io.stdout.write(row + "\n");
  });
};

/** logs/<id>.jsonl under the configured data root. */
const logPath = (ctx: CommandContext, sessionId: string): string => `${ctx.config.dataRoot}/logs/${sessionId}.jsonl`;

/**
 * Poll-driven follow loop: every tick pulls one follower step and hands it to
 * `write`; resolves when `done` fires (ctrl-c/q — docs/03: followers exit 0).
 * The interval belongs to the loop, not to tests: tests drive `step` directly
 * through makeLogFollower (docs/01 §Testing: no sleeps).
 */
export const followLoop = async (
  follower: { step(): { entries: LogEntry[] } },
  intervalMs: number,
  write: (step: { entries: LogEntry[] }) => void,
  done: Promise<boolean>,
): Promise<void> => {
  const timer = setInterval(() => {
    const step = follower.step();
    if (step.entries.length > 0) write(step);
  }, intervalMs);
  await done;
  clearInterval(timer);
};

/** runFollow: shared -f tail for ndjson streaming (key exit path identical). */
const runFollow = async (
  ctx: CommandContext,
  write: (step: { entries: LogEntry[] }) => void,
  sessionId: string,
): Promise<void> => {
  const stdin = ctx.io.stdin as NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void };
  const follower = makeLogFollower(nodeFollowIo(), logPath(ctx, sessionId));
  const quit = quitKeys(stdin).then(
    () => true,
    () => false,
  );
  emitResult(() => {});
  await followLoop(follower, FOLLOW_POLL_MS, write, quit);
};
