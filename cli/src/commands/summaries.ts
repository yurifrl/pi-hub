// hub summaries [id] [--tail N] — the AI summary rail, read straight from <dataRoot>/summaries.jsonl.
// No socket. `<id>` (unique prefix) filters to one session.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SummaryLine } from "@yurifrl/hub";
import type { RegisterCommand } from "../context";
import { CliError } from "../errors";
import { resolveId } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";
import { clockOf, hueBar, knownSessionIds } from "./log";

const DEFAULT_TAIL = 20;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every well-formed line of summaries.jsonl, file order. Absent file → none; torn/invalid lines skipped. */
export const readSummaries = (dataRoot: string): SummaryLine[] => {
  let raw: string;
  try {
    raw = readFileSync(join(dataRoot, "summaries.jsonl"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CliError("usage", `cannot read summaries.jsonl: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  }
  const out: SummaryLine[] = [];
  const cut = raw.lastIndexOf("\n");
  for (const line of (cut < 0 ? "" : raw.slice(0, cut)).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (!isObj(v) || typeof v.sessionId !== "string" || typeof v.text !== "string") continue;
      out.push({
        t: typeof v.t === "string" ? v.t : "",
        sessionId: v.sessionId,
        kind: v.kind === "resolution" ? "resolution" : "summary",
        text: v.text,
        by: typeof v.by === "string" ? v.by : "",
      });
    } catch {
      // skip
    }
  }
  return out;
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("summaries")
    .description("AI summary rail")
    .argument("[id]", "session id (unique prefix) to filter to")
    .option("--tail <n>", `last N lines (default ${DEFAULT_TAIL})`)
    .action((idArg: string | undefined, opts: { tail?: string }) => {
      const tail = opts.tail === undefined ? DEFAULT_TAIL : Number(opts.tail);
      if (!Number.isInteger(tail) || tail < 1) throw new CliError("usage", "--tail needs an integer >= 1");
      const policy = ctx.policy;
      const dataRoot = ctx.config.dataRoot;
      let lines = readSummaries(dataRoot);
      if (idArg !== undefined) {
        const known = knownSessionIds(
          dataRoot,
          lines.map((l) => l.sessionId),
        );
        const { id } = resolveId(idArg, known, "session");
        lines = lines.filter((l) => l.sessionId === id);
      }
      lines = lines.slice(-tail);

      if (policy.format === "json") {
        emitSnapshot(policy, { lines });
        return;
      }
      if (policy.format === "ndjson") {
        for (const l of lines) emitSnapshot(policy, l);
        return;
      }
      const paint = painter(policy);
      for (const l of lines) {
        const token = l.kind === "resolution" ? "ok" : "warn";
        const text = l.text.replace(/\s+/g, " ").trim();
        process.stdout.write(`${hueBar(policy.color, l.sessionId)} ${paint("muted", clockOf(l.t))} ${paint(token, `${l.by} ${text}`)}\n`);
      }
    });
};
