// cli/src/cmd_send.ts — `hub send [id] <msg...>` (docs/03-cli.md
// §Subcommands): id optional → fuzzy arrow picker (needs TTY, else usage 1);
// msg omitted → inline input after selection; cmd `send {target, text}`;
// human `✓ sent to <name>`; --json {sent:true, sessionId, text}.

import { snapshotEnvelope } from "./envelope";
import { writeEnvelope } from "./output";
import { listOp, runOp } from "./hub_ops";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith, failReply } from "./cmd_mutation_helpers";
import { pickSessionInteractive, resolveSessionArg } from "./pick_session";
import { sessionLikes } from "./session_like";
import { displayName } from "./display_name";
import { readLine } from "./io";

export const cmdSend = async (ctx: CommandContext, idOrUndefined: string | undefined, msgParts: string[]): Promise<void> => {
  // docs/03 grammar `send [id] <msg...>`: with no separator a single word is
  // the message (target via picker); two+ words → first is the id.
  let idArg: string | undefined;
  let msgArg: string[];
  if (idOrUndefined === undefined) {
    idArg = undefined;
    msgArg = msgParts;
  } else if (msgParts.length > 0) {
    idArg = idOrUndefined;
    msgArg = msgParts;
  } else {
    idArg = undefined;
    msgArg = [idOrUndefined];
  }

  // 1) snapshot feeds both resolution paths (docs/03: list op reply)
  const listing = await listOp(ctx);
  if (!listing.ok) failReply(ctx, listing);
  const data = (listing.ok ? listing.result : {}) as {
    sessions?: Record<string, Record<string, unknown>>;
  };
  const sessions = data.sessions ?? {};

  let id: string;
  let text = msgArg.join(" ");
  if (idArg !== undefined) {
    id = resolveSessionArg(ctx, sessionLikes(sessions, () => true), idArg);
  } else {
    const open = sessionLikes(sessions, () => true);
    if (open.length === 0) return failWith(ctx, "not_found", "no open sessions to send to");
    id = await pickSessionInteractive(ctx, open, "send");
    // msg omitted → second inline input after selection (docs/03 §Subcommands send)
    if (text.length === 0) {
      text = (await readLine(ctx.io, "message ▏")).trim();
      if (text.length === 0) return failWith(ctx, "usage", "send: empty message");
    }
  }

  // 2) cmd frame send {target, text}
  const reply = await runOp(ctx, "send", { target: id, text });
  if (!reply.ok) failReply(ctx, reply);

  // 3) output
  const name = displayName(id, sessions);
  const format = ctx.policy.format;
  if (format === "human") {
    emitResult(() => {
      ctx.io.stdout.write(`✓ sent to ${name}\n`);
    });
    return;
  }
  emitResult(() => {
    writeEnvelope(snapshotEnvelope({ sent: true, sessionId: id, text }), format);
  });
};
