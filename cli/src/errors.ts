// cli/src/errors.ts — the CLI error taxonomy (spec §Output policies, §Exit codes).
// One ErrorCode → exactly one exit code; the mapping is exhaustive.

import type { HubError } from "@yurifrl/hub";

export type ErrorCode = "usage" | "not_found" | "ambiguous" | "busy" | "unavailable" | "protocol" | "timeout";

export type ExitCode = 0 | 1 | 2 | 3;

const EXIT: Record<ErrorCode, ExitCode> = {
  usage: 1,
  not_found: 1,
  ambiguous: 1,
  busy: 1,
  unavailable: 2,
  protocol: 2,
  timeout: 3,
};

export const exitCodeFor = (code: ErrorCode): ExitCode => EXIT[code];

/** Thrown by commands; bin.ts is the only place that turns it into output + exit. */
export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Map a hub.sock failure (lib HubError) onto the CLI taxonomy. */
export const fromHubError = (e: HubError): CliError => {
  switch (e.code) {
    case "unavailable-hub":
      return new CliError("unavailable", e.message);
    case "timeout":
      return new CliError("timeout", e.message);
    case "unknown-session":
      return new CliError("not_found", e.message);
    case "denied":
      return new CliError("busy", e.message);
  }
};
