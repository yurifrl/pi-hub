// cli/src/cmd_answer.ts — `hub answer <item> <text...>` (docs/03-cli.md
// §Subcommands): resolve the item against the list snapshot, cmd frame
// `answer {id, text}`, human `✓ answered <item> → <name>` + muted text,
// --json {answered:true, id, sessionId}.

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { resolvePrefix, type Resolvable } from "./resolve";
import { listOp, runOp } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith, failReply } from "./cmd_mutation_helpers";
import { displayName } from "./display_name";

export const cmdAnswer = async (ctx: CommandContext, item: string, textParts: string[]): Promise<void> => {
  const text = textParts.join(" ");

  // 1) resolve the attention-item prefix against the `list` snapshot (client-side)
  const listing = await listOp(ctx);
  if (!listing.ok) failReply(ctx, listing);
  const data = (listing.ok ? listing.result : {}) as { attention?: Array<Record<string, unknown>>; sessions?: Record<string, Record<string, unknown>> };
  const sessions = data.sessions ?? {};
  const items = (data.attention ?? []) as Array<{ id?: unknown; sessionId?: unknown }>;
  const resolvables: Resolvable[] = items
    .filter((it) => typeof it.id === "string")
    .map((it) => ({ id: it.id as string, keys: [it.id as string] }));
  const hit = resolvePrefix(resolvables, item);
  if (!hit.ok) {
    if (hit.envelope.type !== "error") return failWith(ctx, "usage", "item resolution failed");
    return failWith(ctx, hit.envelope.error.code, hit.envelope.error.message, hit.envelope.error.detail);
  }
  const id = hit.id;
  const open = items.find((it) => it.id === id);
  const sessionId = typeof open?.sessionId === "string" ? open.sessionId : "";

  // 2) cmd frame answer {id, text}
  const reply = await runOp(ctx, "answer", { id, text });
  if (!reply.ok) failReply(ctx, reply);

  // 3) output (docs/03 §Subcommands `answer`)
  const format = ctx.policy.format;
  if (format === "human") {
    emitResult(() => {
      ctx.io.stdout.write(`✓ answered ${id} → ${displayName(sessionId, sessions)}\n`);
      if (text.length > 0) ctx.io.stdout.write(`  ${text}\n`);
    });
    return;
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ answered: true, id, sessionId }), format);
  });
};
