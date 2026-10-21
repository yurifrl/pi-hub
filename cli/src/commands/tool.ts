// hub tool <id> <tool> [json] — invoke a session tool and print the result.

import type { RegisterCommand } from "../context";
import { CliError } from "../errors";
import { resolveId, rosterOf, sessionName } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";

const MAX_LINES = 50;
const DEFAULT_WAIT_S = 30;

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliError("usage", `invalid json args: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const parseWait = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new CliError("usage", `--wait must be a positive number of seconds, got "${raw}"`);
  return n;
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("tool")
    .description("call a tool on a session")
    .argument("<id>", "session id (unique prefix)")
    .argument("<tool>", "tool name")
    .argument("[json]", "tool args as JSON", "{}")
    .option("--wait <seconds>", "reply deadline in seconds", String(DEFAULT_WAIT_S))
    .action(async (id: string, tool: string, json: string, opts: { wait: string }) => {
      const args = parseJson(json);
      const wait = parseWait(opts.wait);
      const listing = await ctx.call("list", {});
      const roster = rosterOf(listing);
      const session = resolveId(id, roster, "session");
      const deadline = Math.max(ctx.config.replyTimeoutMs, wait * 1000);
      const result = await ctx.call("tool", { target: session.id, tool, args }, deadline);
      emitSnapshot(ctx.policy, { ok: true, result });
      if (ctx.policy.machine) return;
      const paint = painter(ctx.policy);
      const body = JSON.stringify(result, null, 2) ?? "null";
      const lines = body.split("\n");
      const shown = lines.slice(0, MAX_LINES);
      let out = `${paint("accent", "▎")}tool ${tool} -> ${sessionName(session.id, roster)}\n${shown.join("\n")}\n`;
      if (lines.length > MAX_LINES) out += `${paint("muted", `… ${lines.length - MAX_LINES} more`)}\n`;
      process.stdout.write(out);
    });
};
