// hub answer <item> <text...> — resolve an open attention item by replying to its session.

import type { RegisterCommand } from "../context";
import { openAttentionOf, resolveId, rosterOf, sessionName } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("answer")
    .description("answer an open attention item")
    .argument("<item>", "attention item id (unique prefix)")
    .argument("<text...>", "reply text")
    .action(async (item: string, words: string[]) => {
      const text = words.join(" ");
      const listing = await ctx.call("list", {});
      const target = resolveId(item, openAttentionOf(listing), "attention item");
      await ctx.call("answer", { id: target.id, text });
      const data = { answered: true, id: target.id, sessionId: target.sessionId };
      emitSnapshot(ctx.policy, data);
      if (ctx.policy.machine) return;
      const paint = painter(ctx.policy);
      const name = sessionName(target.sessionId, rosterOf(listing));
      process.stdout.write(`${paint("ok", "✓")} answered ${target.id} -> ${name}  ${paint("muted", text)}\n`);
    });
};
