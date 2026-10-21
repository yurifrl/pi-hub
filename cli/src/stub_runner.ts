// cli/src/stub_runner.ts — test-only entry: bin.ts minus the commands/ scan.
// Usage: bun stub_runner.ts <command-module> [args...]. Registers just that module so a
// test is isolated from siblings that fail to load.

import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { createContext, type RegisterCommand } from "./context";
import { CliError, exitCodeFor } from "./errors";
import { reportError, selectPolicy } from "./output";

const [name, ...argv] = process.argv.slice(2);
// Dynamic import is deliberate: the module under test is chosen at runtime.
const mod = (await import(join(import.meta.dir, "commands", `${name}.ts`))) as { register: RegisterCommand };

const program = new Command("hub")
  .option("--config <path>")
  .option("--json")
  .option("--ndjson")
  .option("--no-color")
  .exitOverride()
  .configureOutput({ outputError: () => {} });
const ctx = createContext(program, process.env);
mod.register(program, ctx);

const policyOf = () => {
  try {
    return ctx.policy;
  } catch {
    return selectPolicy({ json: argv.includes("--json") }, false);
  }
};

process.exitCode = await program.parseAsync([name ?? "", ...argv], { from: "user" }).then(
  () => 0,
  (e: unknown) => {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) return 0;
      reportError(policyOf(), new CliError("usage", e.message.replace(/^error: /, "")));
      return exitCodeFor("usage");
    }
    const err = e instanceof CliError ? e : new CliError("usage", e instanceof Error ? e.message : String(e));
    reportError(policyOf(), err);
    return exitCodeFor(err.code);
  },
);
