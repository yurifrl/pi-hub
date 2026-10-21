#!/usr/bin/env bun
// cli/src/bin.ts — composition root of @yurifrl/hub-cli (docs/03-cli.md §bin).
// Boot sequence: parse argv → resolve config → select output policy →
// dispatch. Wires one socket client + one file reader; maps every failure to
// an exit code. No rendering, no domain logic — bodies live in commands.ts,
// rendering in render/.

import { Command } from "commander";
import { resolveConfig, ConfigError } from "./config";
import { selectPolicy, PolicyError, writeEnvelope, type OutputFormat } from "./output";
import { errorEnvelope, exitCodeFor } from "./envelope";
import { makeFileReader } from "./files";
import { hubCmd } from "./hub_socket";
import { processIo } from "./io";
import {
  type CommandBody,
  type CommandContext,
  NotImplemented,
  answerBody,
  archiveCloseBody,
  archiveListBody,
  assignBody,
  boardBody,
  killBody,
  logBody,
  sendBody,
  spawnBody,
  summariesBody,
  toolBody,
  watchBody,
  webBody,
  serveBody,
  agentBody,
  tailsBody,
  pingBody,
  sessionsBody,
} from "./commands";
import { KillDeclined } from "./cmd_kill";
import { CliError } from "./cli_errors";
import { mixedTail } from "./commands";

/** Global flags, accepted before or after any subcommand (docs/03 §bin). */
const GLOBALS = (c: Command): Command =>
  c.option("--config <path>").option("--json").option("--ndjson").option("--no-color");

const parsePositiveInt = (value: string): number => {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`must be a positive integer, got "${value}"`);
  return n;
};

/** The invocation recorded by commander's action callbacks, dispatched after config resolution. */
type Invocation = { body: CommandBody; args: unknown[] };
let dispatched: Invocation | null = null;

const invoke =
  (body: CommandBody) =>
  (...args: unknown[]) => {
    dispatched = { body, args };
  };
// ---- commander tree (docs/03 §Commander tree) ---------------------------

const program = new Command();
// commander's own error/help text stays off our channels: usage failures get
// exactly one hub-formatted line (human stderr) or one envelope (machine).
program.configureOutput({ writeErr: () => {} });
program
  .name("hub")
  .version("0.1.0")
  .description("pi-hub terminal surface — attention board, one-shot verbs, full-screen console")
  .exitOverride() // help/version/usage errors become exceptions mapped to exit codes below
  .enablePositionalOptions();
GLOBALS(program);
program.action(invoke(boardBody));

/**
 * Declare one subcommand: global flags accepted before or after it
 * (docs/03 §Commander tree), own options chained by the caller.
 */
const sub = (decl: string, description: string): Command =>
  GLOBALS(program.command(decl).description(description));

sub("answer <item> <text...>", "reply to an attention item, resolves it").action((item: string, text: string[]) =>
  invoke(answerBody)(item, text),
);

sub("assign [id] <task...>", "give a session work").action((id: string | undefined, task: string[]) =>
  invoke(assignBody)(mixedTail(id, task)),
);

sub("log [-f] [id]", "raw session stream")
  .option("-f", "follow appended lines")
  .action((id: string | undefined, opts: { f?: boolean }) => invoke(logBody)(id, opts));

sub("summaries [id]", "AI summary rail")
  .option("--tail <n>", "last N lines", parsePositiveInt)
  .action(invoke(summariesBody));

sub("send [id] <msg...>", "deliver a prompt to a session").action((id: string | undefined, msg: string[]) =>
  invoke(sendBody)(mixedTail(id, msg)),
);

sub("tool <id> <tool> [json]", "run a tool inside a session")
  .option("--wait <seconds>", "tool budget in seconds", parsePositiveInt)
  .action((id: string, tool: string, json: string | undefined, opts: { wait?: number }) =>
    invoke(toolBody)(id, tool, json, opts),
  );

sub("spawn", "spawn a worker session")
  .option("--name <name>")
  .option("--model <model>")
  .action((opts: { name?: string; model?: string }) => invoke(spawnBody)(opts));

sub("kill <id>", "close a session (red confirm)")
  .option("--yes", "skip the confirm prompt")
  .action((id: string, opts: { yes?: boolean }) => invoke(killBody)(id, opts));

sub("archive [id]", "list the archive / close+archive a session").action((id: string | undefined) =>
  invoke(id === undefined ? archiveListBody : archiveCloseBody)(id),
);

sub("watch", "full-screen split console").action(invoke(watchBody));

sub("agent", "start the hub agent")
  .option("--surface <surface>")
  .action(invoke(agentBody));

sub("tails", "transcript-tail bridge: feed the hub sessions that cannot report themselves").action(invoke(tailsBody));

sub("web", "serve the Hub Console")
  .option("--port <port>", "bind port", parsePositiveInt)
  .action(invoke(webBody));

sub("serve", "run a standalone hub on the socket (docs/07 §Run)").action(invoke(serveBody));

sub("ping", "liveness probe: exit 0 hub live, 2 dead (docs/03 §Exit codes)").action(invoke(pingBody));
sub("sessions", "machine-wide omp inventory: roster ∪ transcripts (docs/02 §Sessions op)").action(invoke(sessionsBody));

// ---- boot ---------------------------------------------------------------

type GlobalOpts = {
  config?: string;
  json?: boolean;
  ndjson?: boolean;
  color?: boolean; // --no-color flips to false
};

/** Machine format requested by raw argv — used for error envelopes when parse fails early. */
const argvFormat = (argv: string[]): OutputFormat => {
  const json = argv.includes("--json");
  const ndjson = argv.includes("--ndjson");
  return json && !ndjson ? "json" : ndjson && !json ? "ndjson" : "human";
};

/** One usage-class failure: envelope on stdout (machine) or one stderr line (human). Exit 1. */
const emitUsage = (argv: string[], message: string): 1 => {
  const format = argvFormat(argv);
  if (format === "human") {
    process.stderr.write(`hub: ${message}\n`);
  } else {
    writeEnvelope(errorEnvelope("usage", message), format);
  }
  process.exitCode = exitCodeFor("usage");
  return 1;
};

/** Commander help/version are successful exits that never open the socket (docs/03 §bin). */
const commanderExitOk = (e: unknown): boolean => {
  const code = (e as { code?: string }).code;
  return code === "commander.helpDisplayed" || code === "commander.version" || code === "commander.help";
};

/**
 * Run one parsed invocation. Boot sequence per docs/03 §bin. Returns the
 * process exit code; exposed for the exit-code table test.
 */
export const run = async (argv: string[]): Promise<number> => {
  dispatched = null;

  // 1) parse argv — commander throws for unknown flags, missing args, help, version
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (e) {
    if (commanderExitOk(e)) return 0;
    return emitUsage(argv, (e as Error).message ?? "invalid invocation");
  }

  const invoked = dispatched as Invocation | null;
  const globals: GlobalOpts = { ...program.opts(), ...(invoked ? lastOpts() : {}) };

  // 2) resolve config — first hit wins; --config problems are usage errors
  let config;
  try {
    config = resolveConfig(globals.config !== undefined ? { configPath: globals.config, argv } : { argv });
  } catch (e) {
    if (e instanceof ConfigError) return emitUsage(argv, e.message);
    throw e;
  }

  // 3) select output policy — --json + --ndjson → usage exit 1
  let policy;
  try {
    policy = selectPolicy({ json: globals.json === true, ndjson: globals.ndjson === true }, config.color);
  } catch (e) {
    if (e instanceof PolicyError) return emitUsage(argv, e.message);
    throw e;
  }

  // 4) dispatch — one socket client + one file reader, built once
  if (!invoked) {
    // no action ran (should not happen: every leaf has an action; bare hub boards)
    return emitUsage(argv, "no command given");
  }
  const ctx: CommandContext = {
    config,
    policy,
    files: makeFileReader(config),
    io: processIo(),
    cmd: async (op, args, timeoutMs, by) => {
      const out = await hubCmd(config.sock, op, args, timeoutMs ?? config.replyTimeoutMs, by);
      return "result" in out ? out : { error: { code: out.error.code, message: out.error.message } };
    },
  };
  try {
    await invoked.body(ctx, ...(invoked.args as never[]));
    return 0;
  } catch (e) {
    if (e instanceof KillDeclined) return 0; // declined kill confirm — clean exit, no changes
    if (e instanceof CliError) return exitCodeFor(e.code); // failure channel already emitted the envelope/stderr line
    if (e instanceof NotImplemented) return emitUsage(argv, e.message);
    // unhandled exception → exit 1, message on stderr (docs/03 §Exit codes Decision)
    if (policy.format === "human") {
      process.stderr.write(`hub: ${(e as Error).message}\n`);
    } else {
      writeEnvelope(errorEnvelope("usage", (e as Error).message), policy.format);
    }
    process.exitCode = 1;
    return 1;
  }
};

/**
 * Options of the command that ran last (commander fires actions
 * innermost-last, so the subcommand's opts land after the parent's).
 */
const lastOpts = (): Record<string, unknown> => {
  let opts: Record<string, unknown> = {};
  const walk = (c: Command): void => {
    opts = { ...opts, ...c.opts() };
    for (const sub of c.commands) walk(sub);
  };
  walk(program);
  return opts;
};

const main = async (): Promise<void> => {
  const code = await run(process.argv.slice(2));
  process.exit(code);
};

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`hub: ${(e as Error)?.message ?? String(e)}\n`);
    process.exit(1);
  });
}
