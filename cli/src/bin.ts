#!/usr/bin/env bun
// cli/src/bin.ts — composition root of @yurifrl/hub-cli. Builds the commander tree,
// loads every module in commands/ (each exports `register`), maps failures to exit codes.
// No rendering, no domain logic here.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { createContext, type CliContext, type RegisterCommand } from "./context";
import { CliError, exitCodeFor } from "./errors";
import { reportError, selectPolicy, type OutputPolicy } from "./output";

const COMMANDS_DIR = join(import.meta.dir, "commands");

// Dynamic import is deliberate: commands/ is a runtime-scanned registry, so parallel
// owners add a file without editing a central index.
const loadCommands = async (program: Command, ctx: CliContext): Promise<void> => {
  const files = readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
  for (const f of files) {
    const mod = (await import(join(COMMANDS_DIR, f))) as { register?: RegisterCommand };
    if (typeof mod.register !== "function") throw new Error(`commands/${f} must export \`register\``);
    mod.register(program, ctx);
  }
};

/** ctx.policy can throw (bad --config, --json with --ndjson); error reporting must not. */
const safePolicy = (ctx: CliContext, argv: string[]): OutputPolicy => {
  try {
    return ctx.policy;
  } catch {
    const json = argv.includes("--json");
    return selectPolicy({ json, ndjson: !json && argv.includes("--ndjson") }, false);
  }
};

const main = async (argv: string[]): Promise<number> => {
  const program = new Command("hub")
    .description("pi-hub — attention board and session control")
    .version("0.1.0", "-V, --version")
    .option("--config <path>", "config file (overrides env and ~/.hub/config.json)")
    .option("--json", "machine output: one JSON envelope")
    .option("--ndjson", "machine output: one JSON line per envelope")
    .option("--no-color", "disable ANSI colors")
    .exitOverride()
    .configureOutput({ outputError: () => {} }); // errors are reported once, as an envelope or a human line

  const ctx = createContext(program, process.env);
  await loadCommands(program, ctx);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      // help / version print and exit 0; everything else is a usage error
      if (e.exitCode === 0) return 0;
      reportError(safePolicy(ctx, argv), new CliError("usage", e.message.replace(/^error: /, "")));
      return exitCodeFor("usage");
    }
    const err = e instanceof CliError ? e : new CliError("usage", e instanceof Error ? e.message : String(e));
    reportError(safePolicy(ctx, argv), err);
    return exitCodeFor(err.code);
  }
};

process.exitCode = await main(process.argv.slice(2));
