// cli/src/emit.ts — the single success gate for command bodies (docs/03-cli.md
// §Exit codes: a successful invocation ends with process.exitCode 0 pinned
// exactly once; failures travel through cmd_mutation_helpers.failWith).

/** Successful body completion: run the output writes, pin exit code 0 exactly once. */
export const emitResult = (write: () => void): void => {
  write();
  if (process.exitCode === undefined) process.exitCode = 0;
};
