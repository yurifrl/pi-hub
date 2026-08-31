// cli/src/output.ts — output-policy plumbing (docs/03-cli.md §Output policies).
// Policy decision (json vs ndjson vs human), envelope serialization, and the
// process-exit mapping. Rendering (human text, ANSI) lives in cli/src/render/ —
// not here (docs/03 §bin: bin.ts contains no rendering).

import { exitCodeFor, type ErrorCode, type OutputEnvelope } from "./envelope";

export type OutputFormat = "human" | "json" | "ndjson";

export type OutputPolicy = {
  format: OutputFormat;
  color: boolean;
};

/** argv-level format collision: --json together with --ndjson → usage, exit 1. */
export class PolicyError extends Error {}

export const selectPolicy = (argv: { json?: boolean; ndjson?: boolean }, color: boolean): OutputPolicy => {
  if (argv.json && argv.ndjson) {
    throw new PolicyError("--json and --ndjson are mutually exclusive");
  }
  return {
    format: argv.json ? "json" : argv.ndjson ? "ndjson" : "human",
    color,
  };
};

/**
 * Serialize one envelope for machine modes. json: pretty two-space object +
 * trailing newline. ndjson: compact single line + newline. Never ANSI.
 */
export const serializeEnvelope = (env: OutputEnvelope, format: "json" | "ndjson"): string => {
  const line = format === "ndjson" ? JSON.stringify(env) : JSON.stringify(env, null, 2);
  return line + "\n";
};

export const writeEnvelope = (env: OutputEnvelope, format: "json" | "ndjson"): void => {
  process.stdout.write(serializeEnvelope(env, format));
};

/** Process exit for one envelope's error code — exhaustive over ErrorCode. */
export const exitForError = (code: ErrorCode): never => {
  process.exit(exitCodeFor(code));
};
