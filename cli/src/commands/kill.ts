// hub kill <id> — close a session (SIGTERM farewell + archive). Confirms unless --yes.

import type { RegisterCommand } from "../context";
import { CliError } from "../errors";
import { resolveId, rosterOf, sessionName } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";
import { confirm, isInteractive } from "../prompt";

const monthOf = (iso: string): string => iso.slice(0, 7);

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("kill")
    .description("kill and archive a session")
    .argument("<id>", "session id (unique prefix)")
    .option("--yes", "skip the confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      const listing = await ctx.call("list", {});
      const roster = rosterOf(listing);
      const session = resolveId(id, roster, "session");
      const name = sessionName(session.id, roster);
      if (!opts.yes) {
        if (!isInteractive(ctx.policy.machine)) {
          throw new CliError("usage", "kill needs confirmation: run it in a terminal or pass --yes");
        }
        if (!(await confirm(`kill ${name}? [y/N] `))) return;
      }
      const reply = (await ctx.call("kill", { sessionId: session.id })) as { closedAt?: string } | undefined;
      const archivedTo = reply?.closedAt ? `archive/${monthOf(reply.closedAt)}/${session.id}.json` : undefined;
      emitSnapshot(ctx.policy, { killed: true, id: session.id, ...(archivedTo ? { archivedTo } : {}) });
      if (ctx.policy.machine) return;
      const paint = painter(ctx.policy);
      process.stdout.write(
        `${paint("ok", "✓")} killed ${name}${archivedTo ? ` - archived to ${paint("muted", archivedTo)}` : ""}\n`,
      );
    });
};
