// cli/src/commands.ts — command bodies (docs/03-cli.md §bin: command bodies
// live here; bin.ts composes and dispatches, contains no domain logic).
//
// Each body receives a typed context (socket client + file reader + io +
// config + output policy) and is wired into the tree. Mutations and archive
// listing are real implementations (tk-tku); the board family and remaining
// read-only views belong to later tasks (tk-avx/tk-2xf render/screens) and
// throw NotImplemented — a typed usage-class error bin maps to the standard
// usage envelope.

import type { HubCliConfig } from "./config";
import type { HubFiles } from "./files";
import type { OutputPolicy } from "./output";
import type { CommandIo } from "./io";
import { cmdAnswer } from "./cmd_answer";
import { cmdAssign } from "./cmd_assign";
import { cmdSend } from "./cmd_send";
import { cmdTool } from "./cmd_tool";
import { cmdSpawn } from "./cmd_spawn";
import { cmdKill } from "./cmd_kill";
import { cmdArchiveClose, cmdArchiveList } from "./cmd_archive";
import { cmdLog } from "./cmd_log";
import { cmdSummaries } from "./cmd_summaries";
import { cmdWatch } from "./cmd_watch";

/** Commander grammar keeps `[id] <text...>` unsplit — the body owns the split. */
export type MixedTail = { head: string | undefined; tail: string[] };

/** Commander grammar keeps `[id] <text...>` unsplit — the body owns the split. */
export const mixedTail = (head: string | undefined, tail: string[]): MixedTail => ({ head, tail });

/** Typed placeholder for bodies owned by later tasks (tk-avx board, tk-2xf watch). */
export class NotImplemented extends Error {
  readonly op: string;
  constructor(op: string, owner: string) {
    super(`${op} is not implemented yet — owned by ${owner}`);
    this.op = op;
  }
}

/** One-shot hub.sock cmd/reply, normalized: result or HubError (never throws). */
export type CmdFn = (
  op: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<{ result: unknown } | { error: { code: string; message: string } }>;

/** Everything a command body may touch — built once in bin.ts (§bin composition root). */
export type CommandContext = {
  config: HubCliConfig;
  policy: OutputPolicy;
  files: HubFiles;
  /** terminal surface for prompts, pickers, confirm lines (docs/03 §Output policies) */
  io: CommandIo;
  /** one-shot hub.sock cmd/reply — see hub_socket.ts */
  cmd: CmdFn;
};

export type CommandBody = (ctx: CommandContext, ...args: never[]) => Promise<void> | void;

// ---- board family (tk-avx board screen, tk-2xf watch) -----------------------

export const boardBody: CommandBody = () => {
  throw new NotImplemented("hub (board)", "tk-avx");
};

export const watchBody: CommandBody = async (ctx: CommandContext): Promise<void> => {
  await cmdWatch(ctx);
};

// ---- read-only commands (socket-free) --------------------------------------

export const logBody: CommandBody = async (ctx, id, opts): Promise<void> => {
  await cmdLog(ctx, (opts as { f?: boolean } | undefined)?.f === true, id as string | undefined);
};

export const summariesBody: CommandBody = async (ctx, id, opts): Promise<void> => {
  await cmdSummaries(ctx, id as string | undefined, (opts as { tail?: number } | undefined)?.tail);
};

export const archiveListBody: CommandBody = async (ctx: CommandContext): Promise<void> => {
  await cmdArchiveList(ctx);
};

// ---- hub-backed mutations (cmd frames over hub.sock) ------------------------

export const answerBody: CommandBody = async (ctx, item, textParts): Promise<void> => {
  await cmdAnswer(ctx, item as string, textParts as string[]);
};

export const assignBody: CommandBody = async (ctx, tail: MixedTail): Promise<void> => {
  await cmdAssign(ctx, tail.head, tail.tail);
};

export const sendBody: CommandBody = async (ctx, tail: MixedTail): Promise<void> => {
  await cmdSend(ctx, tail.head, tail.tail);
};

export const toolBody: CommandBody = async (ctx, id, tool, jsonArg, opts): Promise<void> => {
  await cmdTool(ctx, id as string, tool as string, jsonArg as string | undefined, (opts as { wait?: number })?.wait);
};

export const spawnBody: CommandBody = async (ctx, opts): Promise<void> => {
  await cmdSpawn(ctx, (opts ?? {}) as { name?: string; model?: string });
};

export const killBody: CommandBody = async (ctx, id, opts): Promise<void> => {
  await cmdKill(ctx, id as string, (opts ?? {}) as { yes?: boolean });
};

export const archiveCloseBody: CommandBody = async (ctx, id): Promise<void> => {
  await cmdArchiveClose(ctx, id as string);
};

export const agentBody: CommandBody = () => {
  throw new NotImplemented("hub agent", "tk-tku");
};

export const webBody: CommandBody = () => {
  throw new NotImplemented("hub web", "tk-tku");
};
