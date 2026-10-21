// cli/src/output.ts — output policy + envelope emission (spec §Output policies).
// Machine modes: exactly one envelope per invocation on stdout, no ANSI.

import { CliError, type ErrorCode } from "./errors";

export type OutputFormat = "human" | "json" | "ndjson";

export type OutputPolicy = {
  format: OutputFormat;
  color: boolean;
  /** true for --json / --ndjson */
  machine: boolean;
};

export type OutputEnvelope =
  | { type: "snapshot"; data: unknown }
  | { type: "error"; error: { code: ErrorCode; message: string; detail?: unknown } };

export const selectPolicy = (flags: { json?: boolean; ndjson?: boolean }, color: boolean): OutputPolicy => {
  if (flags.json && flags.ndjson) throw new CliError("usage", "--json and --ndjson are mutually exclusive");
  const format: OutputFormat = flags.json ? "json" : flags.ndjson ? "ndjson" : "human";
  return { format, color: color && format === "human", machine: format !== "human" };
};

export const serializeEnvelope = (env: OutputEnvelope, format: "json" | "ndjson"): string =>
  (format === "json" ? JSON.stringify(env, null, 2) : JSON.stringify(env)) + "\n";

/** Machine mode: write one snapshot envelope. Human mode: no-op — the caller renders. */
export const emitSnapshot = (policy: OutputPolicy, data: unknown): void => {
  if (policy.format === "human") return;
  process.stdout.write(serializeEnvelope({ type: "snapshot", data }, policy.format));
};

/** Report a failure: envelope on stdout (machine) or message on stderr (human). */
export const reportError = (policy: OutputPolicy, err: CliError): void => {
  if (policy.format === "human") {
    process.stderr.write(`hub: ${err.message}\n`);
    return;
  }
  const error: { code: ErrorCode; message: string; detail?: unknown } = { code: err.code, message: err.message };
  if (err.detail !== undefined) error.detail = err.detail;
  process.stdout.write(serializeEnvelope({ type: "error", error }, policy.format));
};
