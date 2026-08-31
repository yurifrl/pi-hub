// cli/src/cmd_mutation_helpers.ts — shared plumbing for the hub-backed
// mutation bodies (docs/03-cli.md §Subcommands): the one failure channel for
// cmd replies, list-snapshot failures, and client-computed usage errors.

import { errorEnvelope, exitCodeFor, type ErrorCode } from "./envelope";
import { writeEnvelope } from "./output";
import { CliError } from "./cli_errors";
import type { CmdOutcome } from "./hub_ops";

/** Minimal surface a body needs to fail correctly. */
export type FailCtx = {
  policy: { format: "human" | "json" | "ndjson" };
  io: { stderr: NodeJS.WritableStream };
};

/** One failure through the standard channel: envelope (machine) or stderr (human), exit per code. */
export const failWith = (ctx: FailCtx, code: ErrorCode, message: string, detail?: unknown): never => {
  if (ctx.policy.format === "human") {
    ctx.io.stderr.write(`hub: ${message}\n`);
  } else {
    writeEnvelope(errorEnvelope(code, message, detail), ctx.policy.format);
  }
  process.exitCode = exitCodeFor(code);
  throw new CliError(code, message);
};

/** A failed cmd/list reply → mapped envelope code + exit. */
export const failReply = (ctx: FailCtx, reply: CmdOutcome & { ok: false }): never => {
  const code = mapWireCode(reply.code);
  return failWith(ctx, code, reply.message);
};

/** Wire failure code → envelope ErrorCode (docs/02 §Error frames, docs/03 §Exit codes). */
export const mapWireCode = (wireCode: string): ErrorCode => {
  switch (wireCode) {
    case "timeout":
      return "timeout"; // exit 3
    case "unavailable-hub":
      return "unavailable"; // exit 2
    case "no-session":
      return "not_found"; // exit 1
    case "busy":
    case "denied":
      return "busy"; // exit 1
    default:
      return "usage"; // exit 1
  }
};
