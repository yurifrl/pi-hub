// hub watch — the full-screen chat console (spec §hub watch, sketch 3).
// Machine modes print one static snapshot envelope; a piped human run prints one static frame;
// a TTY run is the live OpenTUI loop. Hub loss is a rendered state ("hub offline"), never a crash.

import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { cwdFromDir, declaredTitle, idFromName, parseLine, type TranscriptLine } from "@yurifrl/hub";
import { resolveHubEnv } from "../../../extensions/hub_env";
import type { CliContext, RegisterCommand } from "../context";
import { openAttentionOf, rosterOf, type AttentionRow } from "../ids";
import { emitSnapshot } from "../output";
import { isInteractive } from "../prompt";
import { clipText, makePalette, paintLines } from "../tui/colors";
import { decodeKey } from "../tui/keys";
import {
  afterSend,
  chatItems,
  extraGlyph,
  initialState,
  refreshed,
  rosterGlyph,
  selectedRow,
  stepWatch,
  watchLines,
  watchText,
  type ChatKind,
  type ChatRow,
  type Effect,
  type RailRow,
  type WatchState,
} from "../tui/watch_view";
import { readArchive, type ArchiveEntry } from "./archive";
import { translate } from "./tails";

const REFRESH_MS = 2000;
const LIST_DEADLINE_MS = 3000;
const INDEX_TTL_MS = 15_000;
const EXTRAS_CAP = 200;
const CHAT_ROWS = 500;
const CHAT_BYTES = 512 * 1024;
const HEAD_BYTES = 32 * 1024;
const NAME_WIDTH = 24;
const SNAPSHOT_ROWS = 20;
const STATIC_COLS = 80;
const STATIC_ROWS = 24;

// ---- file helpers ------------------------------------------------------------------

/** Complete lines from the head or tail of a file; "" when unreadable. */
const readSlice = (path: string, from: "head" | "tail", bytes: number): string => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const start = from === "tail" ? size - len : 0;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    if (from === "tail" && start > 0) {
      const nl = text.indexOf("\n");
      return nl >= 0 ? text.slice(nl + 1) : "";
    }
    if (from === "head" && len < size) {
      const nl = text.lastIndexOf("\n");
      return nl >= 0 ? text.slice(0, nl) : "";
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

// ---- chat rows ---------------------------------------------------------------------

const LOG_KIND: Record<string, ChatKind | undefined> = { prompt: "user", message: "assistant", tool: "tool", system: "system" };

/** Rows of a hub log (`logs/<id>.jsonl`: one `{t, sessionId, kind, text}` per line). */
export const logRowsOf = (text: string): ChatRow[] => {
  const out: ChatRow[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const kind = typeof rec.kind === "string" ? LOG_KIND[rec.kind] : undefined;
    if (kind === undefined) continue;
    out.push({ t: typeof rec.t === "string" ? rec.t : "", kind, text: typeof rec.text === "string" ? rec.text : "" });
  }
  return out;
};

/** Rows of an omp transcript, translated through the reporter frame table (`tails`). */
export const transcriptRowsOf = (sessionId: string, text: string): ChatRow[] => {
  const out: ChatRow[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const line = parseLine(raw);
    if (line === null) continue;
    const stamp = (line as TranscriptLine & { timestamp?: unknown }).timestamp;
    const t = typeof stamp === "string" ? stamp : "";
    for (const f of translate(sessionId, line)) {
      const p = f.payload;
      if (f.frame === "user_message") out.push({ t, kind: "user", text: String(p.text ?? "") });
      else if (f.frame === "assistant_message") out.push({ t, kind: "assistant", text: String(p.text ?? "") });
      else if (f.frame === "tool_call") {
        const args = typeof p.args === "string" ? p.args : JSON.stringify(p.args ?? {});
        out.push({ t, kind: "tool", text: `${String(p.tool ?? "")} ${args}` });
      }
    }
  }
  return out;
};

// ---- loader: rail + chat -----------------------------------------------------------

type TranscriptRef = { path: string; dir: string };

const scanTranscripts = (root: string): Map<string, TranscriptRef> => {
  const found = new Map<string, TranscriptRef & { mtimeMs: number }>();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return found;
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, dir, name);
      const mtimeMs = mtimeOf(path);
      const id = idFromName(name);
      const prev = found.get(id);
      if (prev === undefined || mtimeMs > prev.mtimeMs) found.set(id, { path, dir, mtimeMs });
    }
  }
  return found;
};

type Extra = { id: string; kind: "archived" | "log"; t: number };

export type Loader = {
  /** rail rows + open attention items from the last `list` reply (null = hub never answered) */
  rail(list: unknown): { rail: RailRow[]; attention: AttentionRow[] };
  /** the selected session's conversation, newest last */
  chat(row: RailRow | undefined): ChatRow[];
};

export const createLoader = (dataRoot: string, sessionsRoot: string, now: () => number = Date.now): Loader => {
  let index = new Map<string, TranscriptRef>();
  let indexAt = -Infinity;
  const getIndex = (): Map<string, TranscriptRef> => {
    if (now() - indexAt > INDEX_TTL_MS) {
      index = scanTranscripts(sessionsRoot);
      indexAt = now();
    }
    return index;
  };
  const names = new Map<string, string>();
  const extraName = (id: string): string => {
    const known = names.get(id);
    if (known !== undefined) return known;
    const ref = getIndex().get(id);
    let name = "";
    if (ref !== undefined) {
      name = declaredTitle(readSlice(ref.path, "head", HEAD_BYTES).split("\n").map(parseLine).filter((l): l is TranscriptLine => l !== null));
      if (name === "") name = basename(cwdFromDir(ref.dir));
    }
    const out = clipText(name === "" ? id.slice(0, 8) : name, NAME_WIDTH);
    names.set(id, out);
    return out;
  };

  const logPath = (id: string): string => join(dataRoot, "logs", `${id}.jsonl`);

  const extras = (skip: ReadonlySet<string>): Extra[] => {
    const byId = new Map<string, Extra>();
    try {
      for (const name of readdirSync(join(dataRoot, "logs"))) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length);
        if (!skip.has(id)) byId.set(id, { id, kind: "log", t: mtimeOf(join(dataRoot, "logs", name)) });
      }
    } catch {
      // no logs dir yet: nothing to list
    }
    let archive: ArchiveEntry[] = [];
    try {
      archive = readArchive(dataRoot);
    } catch {
      // unreadable archive dir: the board for archives is `hub archive`; the rail just skips them
    }
    for (const e of archive) {
      if (skip.has(e.id)) continue;
      const closed = Date.parse(e.closedAt);
      byId.set(e.id, { id: e.id, kind: "archived", t: Number.isNaN(closed) ? (byId.get(e.id)?.t ?? 0) : closed });
    }
    return [...byId.values()].sort((a, b) => b.t - a.t).slice(0, EXTRAS_CAP);
  };

  return {
    rail(list) {
      const roster = list === null ? [] : rosterOf(list);
      const attention = list === null ? [] : openAttentionOf(list);
      const open = new Map<string, number>();
      for (const a of attention) open.set(a.sessionId, (open.get(a.sessionId) ?? 0) + 1);
      const rows: RailRow[] = roster.map((s) => {
        const n = open.get(s.id) ?? 0;
        const g = rosterGlyph(s.phase, n);
        return {
          id: s.id,
          name: clipText(basename(s.cwd) || s.id.slice(0, 8), NAME_WIDTH),
          kind: "roster",
          phase: s.phase,
          glyph: g.glyph,
          tone: g.tone,
          open: n,
        };
      });
      rows.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
      for (const e of extras(new Set(roster.map((s) => s.id)))) {
        const g = extraGlyph(e.kind);
        rows.push({ id: e.id, name: extraName(e.id), kind: e.kind, phase: "", glyph: g.glyph, tone: g.tone, open: 0 });
      }
      return { rail: rows, attention };
    },
    chat(row) {
      if (row === undefined) return [];
      const fromLog = logRowsOf(readSlice(logPath(row.id), "tail", CHAT_BYTES));
      if (fromLog.length > 0) return fromLog.slice(-CHAT_ROWS);
      const ref = getIndex().get(row.id);
      if (ref === undefined) return [];
      return transcriptRowsOf(row.id, readSlice(ref.path, "tail", CHAT_BYTES)).slice(-CHAT_ROWS);
    },
  };
};

// ---- snapshot ----------------------------------------------------------------------

export const watchSnapshot = (s: WatchState): Record<string, unknown> => {
  const row = selectedRow(s);
  return {
    offline: s.offline,
    session: row === undefined ? null : { id: row.id, name: row.name, kind: row.kind, phase: row.phase },
    chat: chatItems(s.chat, "all")
      .slice(-SNAPSHOT_ROWS)
      .map(({ row: r, n }) => ({ t: r.t, kind: r.kind, text: r.text, ...(n > 1 ? { n } : {}) })),
    attention: s.attention.map(({ id, sessionId, kind, text }) => ({ id, sessionId, kind, text })),
  };
};

// ---- command -----------------------------------------------------------------------

type Source = { loader: Loader; list: unknown; offline: boolean };

const fetchList = async (ctx: CliContext, src: Source): Promise<void> => {
  try {
    src.list = await ctx.call("list", {}, LIST_DEADLINE_MS);
    src.offline = false;
  } catch {
    // the last good roster stays on screen; only the header changes
    src.offline = true;
  }
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const runLive = async (ctx: CliContext, src: Source, first: WatchState): Promise<void> => {
  const palette = makePalette(ctx.policy.color);
  let state = first;
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    exitSignals: ["SIGINT", "SIGTERM"],
    useMouse: false,
    backgroundColor: palette.base,
  });
  const done = Promise.withResolvers<void>();
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    if (!renderer.isDestroyed) renderer.destroy();
    done.resolve();
  };
  const draw = (): void => {
    if (!finished && !renderer.isDestroyed) renderer.requestRender();
  };

  let busy = false;
  const reload = async (): Promise<void> => {
    if (busy || finished) return;
    busy = true;
    try {
      await fetchList(ctx, src);
      state = refreshed(state, { ...src.loader.rail(src.list), offline: src.offline });
      state = { ...state, chat: src.loader.chat(selectedRow(state)) };
      draw();
    } finally {
      busy = false;
    }
  };

  const nameOf = (id: string): string => state.rail.find((r) => r.id === id)?.name ?? id.slice(0, 8);

  const perform = async (effect: Effect | undefined): Promise<void> => {
    if (effect === undefined) return;
    switch (effect.kind) {
      case "quit":
        finish();
        return;
      case "load":
        state = { ...state, chat: src.loader.chat(selectedRow(state)) };
        draw();
        return;
      case "send":
        try {
          if (effect.answerId !== undefined) await ctx.call("answer", { id: effect.answerId, text: effect.text });
          else await ctx.call("send", { target: effect.id, text: effect.text });
          state = afterSend(state, true, {
            tone: "ok",
            text: `${effect.answerId !== undefined ? "answered" : "sent to"} ${nameOf(effect.id)}`,
          });
        } catch (e) {
          state = afterSend(state, false, { tone: "err", text: message(e) });
        }
        draw();
        await reload();
        return;
      case "dismiss":
        try {
          await ctx.call("attention", { action: "dismiss", id: effect.id });
          state = { ...state, notice: { tone: "ok", text: `dismissed ${effect.id}` } };
        } catch (e) {
          state = { ...state, notice: { tone: "err", text: message(e) } };
        }
        draw();
        await reload();
        return;
    }
  };

  renderer.addPostProcessFn((buffer) => {
    paintLines(buffer, watchLines(state, { w: buffer.width, h: buffer.height }), palette);
  });
  renderer.keyInput.on("keypress", (ev) => {
    const step = stepWatch(state, decodeKey(ev), { w: renderer.width, h: renderer.height });
    state = step.state;
    draw();
    void perform(step.effect).catch(() => {
      // a failed effect leaves the screen as is; the next refresh shows the truth
    });
  });
  renderer.on("destroy", finish);
  timer = setInterval(() => void reload(), REFRESH_MS);
  draw();
  await done.promise;
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("watch")
    .description("full-screen chat console: sessions rail + conversation")
    .action(async () => {
      const policy = ctx.policy;
      const { config } = ctx;
      const src: Source = {
        loader: createLoader(config.dataRoot, resolveHubEnv().sessionsRoot),
        list: null,
        offline: false,
      };
      await fetchList(ctx, src);
      const live = isInteractive(policy.machine);
      const { rail, attention } = src.loader.rail(src.list);
      let state = initialState(rail, attention, { offline: src.offline, keysOff: !live });
      state = { ...state, chat: src.loader.chat(selectedRow(state)) };
      if (policy.machine) {
        emitSnapshot(policy, watchSnapshot(state));
        return;
      }
      if (!live) {
        const w = process.stdout.columns ?? STATIC_COLS;
        const h = process.stdout.rows ?? STATIC_ROWS;
        process.stdout.write(`${watchText(state, { w, h })}\n\nrun hub watch in a terminal for the live console\n`);
        return;
      }
      await runLive(ctx, src, state);
    });
};
