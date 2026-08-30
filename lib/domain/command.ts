// lib/domain/command.ts — shared vocabulary for every port result and surface reply.
// Pure types + pure functions; zero imports (docs/01-architecture.md §Core abstractions).

/** Errors are values, not exceptions (docs/01 §Error model). */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Closed error taxonomy — the only codes a HubError may carry. */
export type HubCode = "unavailable-hub" | "unknown-session" | "timeout" | "denied";

export type HubError = {
  code: HubCode;
  /** human text, presentable as-is by any surface */
  message: string;
  /** true only for transient unavailable-hub / timeout */
  retryable: boolean;
  /** structured detail, never a thrown Error instance */
  cause?: unknown;
};

export const hubError = (code: HubCode, message: string, opts?: { retryable?: boolean; cause?: unknown }): HubError => {
  const retryable = opts?.retryable ?? (code === "unavailable-hub" || code === "timeout");
  return {
    code,
    message,
    retryable,
    ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
  };
};

/** The one op registry every surface speaks. */
export type OpName =
  | "list"
  | "attention"
  | "answer"
  | "assign"
  | "send"
  | "tool"
  | "spawn"
  | "kill"
  | "archive"
  | "logTail"
  | "summaries";

export const OP_NAMES: readonly OpName[] = [
  "list",
  "attention",
  "answer",
  "assign",
  "send",
  "tool",
  "spawn",
  "kill",
  "archive",
  "logTail",
  "summaries",
] as const;

export type Caller = "cli" | "web" | "plugin" | "agent";

export type CommandRequest = {
  /** correlation id echoed by reply frames on hub.sock */
  cmdId: string;
  op: OpName;
  args: Record<string, unknown>;
  by: Caller;
};

export type CommandReply = Result<unknown, HubError>;

export type CommandSurface = {
  dispatch(req: CommandRequest): Promise<CommandReply>;
  /** registry inspection feeding --help and tool schemas */
  ops(): OpName[];
};
