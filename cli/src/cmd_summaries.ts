// cli/src/cmd_summaries.ts — `hub summaries [id] [--tail N]` (docs/03-cli.md
// §Subcommands summaries): reads summaries.jsonl directly, no socket; `<id>`
// filters to one session; `--tail N` last N lines, default 20, N < 1 → usage
// exit 1 (bin's parsePositiveInt already rejects non-integers; 0 passes the
// option parser so the body rejects it here). Human rows `▎▎ <muted time>
// <by> <text>` — summary warn, resolution ok (docs/03 §summaries); the
// per-session tint rides the hue bar. --json snapshot {lines},
// --ndjson one line per row, newest first per --tail ordering.

import type { SummaryLine } from "@yurifrl/hub";
import { snapshotEnvelope } from "./envelope";
import { serializeEnvelope } from "./output";
import type { CommandContext } from "./commands";
import { emitResult } from "./emit";
import { failWith } from "./cmd_mutation_helpers";
import { hueIndex } from "./render/theme";
import { paintStreamLine, summaryStreamLines } from "./render/stream";
import { colorLevelFor, renderRow } from "./log_render";
import { openSessionsFromStatus, resolveIdArg } from "./log_select";

export const cmdSummaries = async (ctx: CommandContext, id: string | undefined, tail: number | undefined): Promise<void> => {
  const n = tail ?? 20;
  if (!Number.isInteger(n) || n < 1) return failWith(ctx, "usage", "summaries: --tail must be a positive integer");

  // newest first (docs/03 §summaries: prints last N lines newest first)
  const newestFirst = (lines: SummaryLine[]): SummaryLine[] => lines.slice().reverse();

  // filter before tail: the rail is per-session when an id is given
  let lines = ctx.files.summaryLines(n * 4); // over-fetch so a filter still yields N rows
  if (id !== undefined) {
    const status = ctx.files.status();
    const sessionId = await resolveIdArg(ctx, openSessionsFromStatus(status), id, "summaries");
    lines = ctx.files.summaryLines(n * 4).filter((l) => l.sessionId === sessionId);
  }
  const shown = newestFirst(lines).slice(0, n);

  const format = ctx.policy.format;
  if (format === "ndjson") {
    return emitResult(() => {
      for (const l of shown) ctx.io.stdout.write(serializeEnvelope(snapshotEnvelope(l), "ndjson"));
    });
  }
  if (format === "json") {
    return emitResult(() => {
      ctx.io.stdout.write(serializeEnvelope(snapshotEnvelope({ lines: shown }), "json"));
    });
  }

  const level = colorLevelFor(ctx);
  return emitResult(() => {
    if (shown.length === 0) {
      ctx.io.stdout.write("(no summaries)\n");
      return;
    }
    for (const line of summaryStreamLines(shown, hueIndex)) {
      ctx.io.stdout.write(renderRow(paintStreamLine(line), level) + "\n");
    }
  });
};
