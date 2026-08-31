// cli/src/envelope.ts — machine output contract (docs/03-cli.md §Output policies):
// exactly one envelope per invocation, always on stdout. Errors are data, not
// thrown exceptions; the exit code is derived from the ErrorCode exhaustively.

export type OutputEnvelope =
  | { type: "snapshot"; data: unknown }
  | { type: "error"; error: { code: ErrorCode; message: string; detail?: unknown } };

export type ErrorCode =
  | "usage" // exit 1 — bad args, parse failures
  | "not_found" // exit 1 — unknown id/item
  | "ambiguous" // exit 1 — prefix matched several
  | "busy" // exit 1 — e.g. agent already running
  | "unavailable" // exit 2 — socket missing/refused, port busy, omp binary missing
  | "protocol" // exit 2 — version mismatch, malformed reply
  | "timeout"; // exit 3

/** ErrorCode → exit code mapping, exhaustive over ErrorCode (docs/03 §Exit codes). */
export const exitCodeFor = (code: ErrorCode): 1 | 2 | 3 => {
  switch (code) {
    case "usage":
    case "not_found":
    case "ambiguous":
    case "busy":
      return 1;
    case "unavailable":
    case "protocol":
      return 2;
    case "timeout":
      return 3;
  }
};

export const snapshotEnvelope = (data: unknown): OutputEnvelope => ({ type: "snapshot", data });

export const errorEnvelope = (code: ErrorCode, message: string, detail?: unknown): OutputEnvelope => ({
  type: "error",
  error: {
    code,
    message,
    ...(detail !== undefined ? { detail } : {}),
  },
});
