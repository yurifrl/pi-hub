// cli/src/cli_errors.ts — command-body failure channel (docs/03-cli.md
// §Output policies: errors are one envelope on stdout in machine modes, one
// stderr line in human mode; the exit code rides the ErrorCode mapping).

import type { OutputEnvelope } from "./envelope";

/**
 * Raised by command bodies after they already emitted the machine envelope
 * (machine modes) — carries the envelope for tests and the human fallback
 * line for bin's catch. `human` is the stderr text for human mode.
 */
export class CliError extends Error {
  readonly envelope: OutputEnvelope | null;
  /** stderr line for human mode; when null, message is used */
  readonly human: string | null;
  readonly code: "usage" | "not_found" | "ambiguous" | "busy" | "unavailable" | "protocol" | "timeout";

  constructor(
    code: CliError["code"],
    message: string,
    opts?: { envelope?: OutputEnvelope; human?: string },
  ) {
    super(message);
    this.code = code;
    this.envelope = opts?.envelope ?? null;
    this.human = opts?.human ?? null;
  }
}
