// hub log [-f] [id] — the raw stream of a session, read straight from <dataRoot>/logs/<id>.jsonl.
// No socket: works while the hub is down. Without an id: picker over the open sessions in status.json.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { hueColorCodes } from "@yurifrl/hub";
import type { CliContext, RegisterCommand } from "../context";
import { CliError } from "../errors";
import { resolveId, rosterOf, type RosterSession } from "../ids";
import { emitSnapshot } from "../output";
import { painter } from "../paint";
import { requireInteractive } from "../prompt";
import { textWidth } from "../tui/colors";
import { pickSession } from "../tui/picker";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Session ids we can resolve a user-supplied prefix against, from disk only. */
export const knownSessionIds = (dataRoot: string, extra: readonly string[] = []): { id: string }[] => {
  const ids = new Set<string>(extra);
  for (const id of Object.keys(readStatusSessions(dataRoot))) ids.add(id);
  try {
    for (const f of readdirSync(join(dataRoot, "logs"))) if (f.endsWith(".jsonl")) ids.add(f.slice(0, -".jsonl".length));
  } catch {
    // no logs dir yet
  }
  return [...ids].map((id) => ({ id }));
};

/** `sessions` map of <dataRoot>/status.json; empty when the file is absent or unreadable. */
export const readStatusSessions = (dataRoot: string): Record<string, Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dataRoot, "status.json"), "utf8"));
  } catch {
    return {};
  }
  if (!isObj(parsed) || !isObj(parsed.sessions)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, rec] of Object.entries(parsed.sessions)) if (isObj(rec)) out[id] = rec;
  return out;
};

/** Open sessions as picker rows. */
const openRows = (dataRoot: string): RosterSession[] => {
  const open: Record<string, Record<string, unknown>> = {};
  for (const [id, rec] of Object.entries(readStatusSessions(dataRoot))) if (rec.status === "open") open[id] = rec;
  return rosterOf({ sessions: open });
};

export type RawLogEntry = Record<string, unknown> & { sessionId?: string; kind?: string; text?: string };

/** Parse complete NDJSON lines; blank/invalid lines are skipped (a torn line never fails the read). */
const parseEntries = (lines: readonly string[]): RawLogEntry[] => {
  const out: RawLogEntry[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObj(v)) out.push(v);
    } catch {
      // skip
    }
  }
  return out;
};

/** Epoch ms of a log timestamp (ISO string or number); NaN when unusable. */
export const timeMs = (t: unknown): number => (typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : Number.NaN);

export const clockOf = (t: unknown): string => {
  const ms = timeMs(t);
  if (Number.isNaN(ms)) return "--:--:--";
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Hue bar `▎` colored by the session hue; plain when color is off. */
export const hueBar = (color: boolean, sessionId: string): string =>
  color ? `\x1b[${hueColorCodes(sessionId)}m▎\x1b[39m` : "▎";

/** Split `text` into rows of at most `room` cells, honoring embedded newlines. */
const wrapText = (text: string, room: number): string[] => {
  const rows: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!Number.isFinite(room)) {
      rows.push(raw);
      continue;
    }
    let cur = "";
    let w = 0;
    for (const ch of raw) {
      const cw = textWidth(ch);
      if (w + cw > room && cur !== "") {
        rows.push(cur);
        cur = "";
        w = 0;
      }
      cur += ch;
      w += cw;
    }
    rows.push(cur);
  }
  return rows;
};

type Renderer = { render(entry: RawLogEntry): string };

const makeRenderer = (ctx: CliContext, sessionId: string, kindW: number): Renderer => {
  const paint = painter(ctx.policy);
  const bar = hueBar(ctx.policy.color, sessionId);
  const width = process.stdout.isTTY ? (process.stdout.columns ?? 80) : Number.POSITIVE_INFINITY;
  const textCol = 1 + 1 + 8 + 1 + kindW + 1;
  const room = Math.max(10, width - textCol);
  const indent = " ".repeat(textCol);
  return {
    render(entry) {
      const kind = typeof entry.kind === "string" ? entry.kind : "";
      const text = typeof entry.text === "string" ? entry.text : "";
      const rows = wrapText(text, room);
      const head = `${bar} ${paint("muted", clockOf(entry.t))} ${paint("accent", kind.padEnd(kindW))} `;
      return rows.map((r, i) => (i === 0 ? head : `${bar}${indent.slice(1)}`) + r).join("\n") + "\n";
    },
  };
};

const kindWidthOf = (entries: readonly RawLogEntry[]): number =>
  Math.min(17, Math.max(6, ...entries.map((e) => (typeof e.kind === "string" ? e.kind.length : 0))));

/**
 * Follow `file` from `offset`: emit each complete appended line, restart from 0 when the
 * file is truncated or replaced (rotation), wait while it is absent. Resolves on SIGINT/SIGTERM.
 */
const follow = (file: string, offset: number, ino: number, onEntries: (entries: RawLogEntry[]) => void): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  {
    let pos = offset;
    let curIno = ino;
    let partial = "";
    const decoder = new TextDecoder();
    const poll = (): void => {
      let st;
      try {
        st = statSync(file);
      } catch {
        return; // absent (mid-rotate): keep waiting
      }
      if (st.ino !== curIno || st.size < pos) {
        curIno = st.ino;
        pos = 0;
        partial = "";
      }
      if (st.size === pos) return;
      let fd: number;
      try {
        fd = openSync(file, "r");
      } catch {
        return;
      }
      try {
        const buf = Buffer.alloc(st.size - pos);
        const n = readSync(fd, buf, 0, buf.length, pos);
        pos += n;
        partial += decoder.decode(buf.subarray(0, n), { stream: true });
      } finally {
        closeSync(fd);
      }
      const cut = partial.lastIndexOf("\n");
      if (cut < 0) return;
      const lines = partial.slice(0, cut).split("\n");
      partial = partial.slice(cut + 1);
      const entries = parseEntries(lines);
      if (entries.length > 0) onEntries(entries);
    };
    const timer = setInterval(poll, 100);
    const stop = (): void => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
  return promise;
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("log")
    .description("raw session stream (-f to follow)")
    .argument("[id]", "session id (unique prefix); omit to pick an open session")
    .option("-f, --follow", "follow appended entries")
    .option("--tail <n>", "only the last N existing entries")
    .action(async (idArg: string | undefined, opts: { follow?: boolean; tail?: string }) => {
      const policy = ctx.policy;
      if (opts.follow && policy.format === "json") throw new CliError("usage", "--json cannot follow; use --ndjson with -f");
      let tail: number | undefined;
      if (opts.tail !== undefined) {
        tail = Number(opts.tail);
        if (!Number.isInteger(tail) || tail < 1) throw new CliError("usage", "--tail needs an integer >= 1");
      }
      const dataRoot = ctx.config.dataRoot;

      let id: string;
      if (idArg === undefined) {
        requireInteractive(policy.machine, "log without an id");
        const rows = openRows(dataRoot);
        if (rows.length === 0) throw new CliError("not_found", "no open sessions");
        const picked = await pickSession(ctx, { query: "", message: "", rows, verb: "log" });
        if (picked === null) return;
        id = picked.id;
      } else {
        id = resolveId(idArg, knownSessionIds(dataRoot), "session").id;
      }

      const file = join(dataRoot, "logs", `${id}.jsonl`);
      let raw: Buffer;
      let ino: number;
      try {
        raw = readFileSync(file);
        ino = statSync(file).ino;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CliError("not_found", `no entries yet for ${id}`);
        throw new CliError("usage", `cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
      }
      // only complete lines are entries; a torn tail is picked up by the follower once finished
      const text = raw.toString("utf8");
      const cut = text.lastIndexOf("\n");
      const complete = cut < 0 ? "" : text.slice(0, cut);
      const consumed = cut < 0 ? 0 : Buffer.byteLength(text.slice(0, cut + 1));
      let entries = parseEntries(complete === "" ? [] : complete.split("\n"));
      if (tail !== undefined) entries = entries.slice(-tail);

      if (policy.format === "json") {
        emitSnapshot(policy, { sessionId: id, entries });
        return;
      }
      const emit = (list: readonly RawLogEntry[], r?: Renderer): void => {
        if (policy.format === "ndjson") {
          for (const e of list) emitSnapshot(policy, e);
        } else if (r) {
          for (const e of list) process.stdout.write(r.render(e));
        }
      };
      const renderer = makeRenderer(ctx, id, kindWidthOf(entries));
      emit(entries, renderer);
      if (!opts.follow) return;
      await follow(file, consumed, ino, (fresh) => emit(fresh, renderer));
    });
};
