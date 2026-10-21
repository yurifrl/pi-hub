// hub assign [id] <task...> — hand a task to a session. No id: pick among idle sessions.
//
// Argument disambiguation (boring choice): with 2+ args the first is the session id
// (strictly resolved: not_found / ambiguous); with 1 arg it is the task and the picker
// chooses the session; with none the picker asks for both.

import { CliError } from "../errors";
import type { RegisterCommand } from "../context";
import { resolveId, rosterOf, sessionName } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";
import { requireInteractive } from "../prompt";
import { pickSession } from "../tui/picker";

const firstLine = (s: string): string => s.split("\n", 1)[0] ?? "";

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("assign")
    .description("assign a task to a session")
    .argument("[args...]", "[id] <task...>")
    .action(async (args: string[]) => {
      const listing = await ctx.call("list", {});
      const roster = rosterOf(listing);
      let id: string;
      let task: string;
      if (args.length >= 2) {
        id = resolveId(args[0] as string, roster, "session").id;
        task = args.slice(1).join(" ");
      } else {
        requireInteractive(ctx.policy.machine, args.length === 0 ? "assign without id and task" : "assign without an id");
        const picked = await pickSession(ctx, {
          query: "",
          ...(args.length === 1 ? { message: args[0] as string } : {}),
          phase: "idle",
        });
        if (picked === null) return;
        if (!picked.message) throw new CliError("usage", "assign needs a task");
        id = picked.id;
        task = picked.message;
      }
      await ctx.call("assign", { id, task });
      emitSnapshot(ctx.policy, { assigned: true, id, sessionId: id, task });
      if (ctx.policy.machine) return;
      const paint = painter(ctx.policy);
      process.stdout.write(`${paint("ok", "✓")} assigned ${sessionName(id, roster)} ${paint("muted", firstLine(task))}\n`);
    });
};
