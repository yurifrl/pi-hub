// cli/src/commands.ts — command bodies (docs/03-cli.md §bin: command bodies
// live here; bin.ts composes and dispatches, contains no domain logic).
//
// tk-dfr delivers the plumbing: each body receives a typed context (socket
// client + file reader + config + output policy) and is wired into the tree.
// Bodies whose wire/format logic belongs to later tasks (tk-tku subcommand
// semantics, tk-aum/tk-avx/tk-2xf render/screens) throw NotImplemented — a
// typed usage-class error that bin maps to the standard usage envelope, so
// the tree, config, envelope, and exit-code layers are exercised end to end
// before those tasks land.

import type { HubCliConfig } from "./config";
import type { HubFiles } from "./files";
import type { OutputPolicy } from "./output";

/** Typed placeholder for bodies owned by later tasks (see module comment). */
export class NotImplemented extends Error {
  readonly op: string;
  constructor(op: string, owner: string) {
    super(`${op} is not implemented yet — owned by ${owner}`);
    this.op = op;
  }
}

/** Everything a command body may touch — built once in bin.ts (§bin composition root). */
export type CommandContext = {
  config: HubCliConfig;
  policy: OutputPolicy;
  files: HubFiles;
  /** one-shot hub.sock cmd/reply — see hub_socket.ts */
  cmd: (op: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<{ result: unknown } | { error: { code: string; message: string } }>;
};

export type CommandBody = (ctx: CommandContext, ...args: never[]) => Promise<void> | void;

// ---- board family (tk-avx board screen, tk-2xf watch) -----------------------

export const boardBody: CommandBody = () => {
  throw new NotImplemented("hub (board)", "tk-avx");
};

export const watchBody: CommandBody = () => {
  throw new NotImplemented("hub watch", "tk-2xf");
};

// ---- read-only commands (socket-free; wire logic tk-tku) --------------------

export const logBody: CommandBody = () => {
  throw new NotImplemented("hub log", "tk-tku");
};

export const summariesBody: CommandBody = () => {
  throw new NotImplemented("hub summaries", "tk-tku");
};

export const archiveListBody: CommandBody = () => {
  throw new NotImplemented("hub archive", "tk-tku");
};

// ---- hub-backed mutations (cmd frames over hub.sock; tk-tku) ----------------

export const answerBody: CommandBody = () => {
  throw new NotImplemented("hub answer", "tk-tku");
};

export const assignBody: CommandBody = () => {
  throw new NotImplemented("hub assign", "tk-tku");
};

export const sendBody: CommandBody = () => {
  throw new NotImplemented("hub send", "tk-tku");
};

export const toolBody: CommandBody = () => {
  throw new NotImplemented("hub tool", "tk-tku");
};

export const spawnBody: CommandBody = () => {
  throw new NotImplemented("hub spawn", "tk-tku");
};

export const killBody: CommandBody = () => {
  throw new NotImplemented("hub kill", "tk-tku");
};

export const archiveCloseBody: CommandBody = () => {
  throw new NotImplemented("hub archive <id>", "tk-tku");
};

export const agentBody: CommandBody = () => {
  throw new NotImplemented("hub agent", "tk-tku");
};

export const webBody: CommandBody = () => {
  throw new NotImplemented("hub web", "tk-tku");
};
