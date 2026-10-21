// hub send [id] <msg...> — queue a message to a session. No id: pick one.
//
// Same argument rule as assign: 2+ args → first is the id; 1 arg → it is the message
// and the picker chooses the session; none → the picker asks for session and message.

import { CliError } from "../errors";
import type { RegisterCommand } from "../context";
import { resolveId, rosterOf, sessionName } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";
import { requireInteractive } from "../prompt";
import { pickSession } from "../tui/picker";

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("send")
    .description("send a message to a session")
    .argument("[args...]", "[id] <msg...>")
    .action(async (args: string[]) => {
      const listing = await ctx.call("list", {});
      const roster = rosterOf(listing);
      let id: string;
      let text: string;
      if (args.length >= 2) {
        id = resolveId(args[0] as string, roster, "session").id;
        text = args.slice(1).join(" ");
      } else {
        requireInteractive(ctx.policy.machine, args.length === 0 ? "send without id and message" : "send without an id");
        const picked = await pickSession(ctx, {
          query: "",
          ...(args.length === 1 ? { message: args[0] as string } : {}),
        });
        if (picked === null) return;
        if (!picked.message) throw new CliError("usage", "send needs a message");
        id = picked.id;
        text = picked.message;
      }
      await ctx.call("send", { target: id, text });
      emitSnapshot(ctx.policy, { sent: true, sessionId: id, text });
      if (ctx.policy.machine) return;
      const paint = painter(ctx.policy);
      process.stdout.write(`${paint("ok", "✓")} sent to ${sessionName(id, roster)}\n`);
    });
};
