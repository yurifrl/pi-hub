// cli/src/emit.ts — the single success gate for command bodies (docs/03-cli.md
// §Exit codes: a successful invocation ends with process.exitCode 0 pinned
// exactly once; failures travel through cmd_mutation_helpers.failWith).
//
// Bun note: `process.exitCode = undefined` does not clear the property (it
// keeps the previous number), so the historical "pin 0 only if unset" guard
// would silently inherit a stale failure code. The gate therefore pins 0
// unconditionally on the success path — failure paths pin their code AFTER
// the last emitResult call (failWith runs emit-before-pin, then throws), so
// ordering makes unconditional pinning safe.

/** Successful body completion: run the output writes, pin exit code 0. */
export const emitResult = (write: () => void): void => {
  write();
  process.exitCode = 0;
};
