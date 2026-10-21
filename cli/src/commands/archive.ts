// hub archive [id] — with an id: archive that session via the hub.
// Without: list closed sessions from <dataRoot>/archive/YYYY-MM/*.json (no socket).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RegisterCommand } from "../context";
import { CliError } from "../errors";
import { resolveId, rosterOf, sessionName } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";

export type ArchiveEntry = {
  id: string;
  closedAt: string;
  closedBy: string;
  finalSummary: string;
  path: string;
};

const SUMMARY_WIDTH = 60;

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Read every archive record under `<dataRoot>/archive`, newest closedAt first. */
export const readArchive = (dataRoot: string): ArchiveEntry[] => {
  const root = join(dataRoot, "archive");
  let months: string[];
  try {
    if (!statSync(root).isDirectory()) throw new CliError("usage", `archive path is not a directory: ${root}`);
    months = readdirSync(root);
  } catch (e) {
    if (e instanceof CliError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CliError("usage", `cannot read archive dir ${root}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  }
  const entries: ArchiveEntry[] = [];
  for (const month of months) {
    let files: string[];
    try {
      files = readdirSync(join(root, month)).filter((f) => f.endsWith(".json"));
    } catch {
      continue; // stray file at month level
    }
    for (const file of files) {
      const rel = `archive/${month}/${file}`;
      let rec: unknown;
      try {
        rec = JSON.parse(readFileSync(join(root, month, file), "utf8"));
      } catch {
        continue; // unreadable/partial record: skip, the listing stays useful
      }
      if (!isObj(rec)) continue;
      entries.push({
        id: str(rec.id) || file.replace(/\.json$/, ""),
        closedAt: str(rec.closedAt),
        closedBy: str(rec.closedBy),
        finalSummary: str(rec.finalSummary),
        path: rel,
      });
    }
  }
  return entries.sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0));
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("archive")
    .description("archive a session, or list the archive")
    .argument("[id]", "session id (unique prefix); omit to list")
    .action(async (id: string | undefined) => {
      const paint = painter(ctx.policy);
      if (id === undefined) {
        const entries = readArchive(ctx.config.dataRoot);
        emitSnapshot(ctx.policy, { entries });
        if (ctx.policy.machine) return;
        if (entries.length === 0) {
          process.stdout.write(`${paint("muted", "archive is empty")}\n`);
          return;
        }
        const idW = Math.max(2, ...entries.map((e) => e.id.length));
        const atW = Math.max(8, ...entries.map((e) => e.closedAt.length));
        const byW = Math.max(9, ...entries.map((e) => e.closedBy.length));
        const row = (a: string, b: string, c: string, d: string): string =>
          `${a.padEnd(idW)}  ${b.padEnd(atW)}  ${c.padEnd(byW)}  ${d}`;
        process.stdout.write(`${paint("muted", row("id", "closedAt", "closedBy", "finalSummary"))}\n`);
        for (const e of entries) {
          process.stdout.write(`${row(e.id, e.closedAt, e.closedBy, clip(e.finalSummary, SUMMARY_WIDTH))}\n`);
        }
        return;
      }
      const listing = await ctx.call("list", {});
      const roster = rosterOf(listing);
      const session = resolveId(id, roster, "session");
      const reply = (await ctx.call("archive", { sessionId: session.id })) as { path?: string } | undefined;
      emitSnapshot(ctx.policy, { archived: true, id: session.id, ...(reply?.path !== undefined ? { path: reply.path } : {}) });
      if (ctx.policy.machine) return;
      process.stdout.write(`${paint("ok", "✓")} archived ${sessionName(session.id, roster)} ${paint("muted", session.id)}\n`);
    });
};
