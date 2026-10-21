// hub tails — the transcript-tail bridge: translates omp transcript lines into reporter
// frames over hub.sock (client:"backfill") so sessions that cannot report appear on the board.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { connectHubClient, type HubClient } from "@yurifrl/hub/adapters/unix_socket";
import { OMP_SESSION_STALE_MS, cwdFromDir, declaredTitle, firstUserText, idFromName, modelFromLines, parseLine, textOf, type TranscriptLine } from "@yurifrl/hub";
import { resolveHubEnv } from "../../../extensions/hub_env";
import type { RegisterCommand } from "../context";
import { CliError } from "../errors";

export type Frame = { frame: string; payload: Record<string, unknown> };

type Tracked = { path: string; dir: string; offset: number; lastActivityMs: number; ended: boolean };
type TailsState = { offsets: Record<string, number>; sessions: Record<string, { path: string; ended: boolean }> };

export type TailsOptions = {
  sock: string;
  sessionsRoot: string;
  stateFile: string;
  quietMs?: number;
  pollMs?: number;
  retryMs?: number;
  /** only transcripts touched at/after this epoch ms are discovered fresh (default: now) */
  startMs?: number;
  signal: AbortSignal;
  log?: (line: string) => void;
};

/** One transcript line → zero or more reporter frames (docs/05 reporter frame table). */
export const translate = (sessionId: string, line: TranscriptLine): Frame[] => {
  if (line.type !== "message" || !line.message) return [];
  const role = line.message.role;
  if (role === "user") {
    const text = textOf(line.message);
    return text ? [{ frame: "user_message", payload: { sessionId, text } }] : [];
  }
  if (role !== "assistant") return [];
  const out: Frame[] = [];
  const text = textOf(line.message);
  if (text) out.push({ frame: "assistant_message", payload: { sessionId, text } });
  for (const part of line.message.content ?? []) {
    if ((part.type === "toolCall" || part.type === "tool_use") && part.name) {
      out.push({ frame: "tool_call", payload: { sessionId, tool: part.name, args: part.arguments ?? {} } });
    }
  }
  return out;
};

const listTranscripts = (root: string): Array<{ path: string; dir: string; name: string; mtimeMs: number; size: number }> => {
  const out: Array<{ path: string; dir: string; name: string; mtimeMs: number; size: number }> = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
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
      try {
        const st = statSync(path);
        if (st.isFile()) out.push({ path, dir, name, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        continue;
      }
    }
  }
  return out;
};

const readRange = (path: string, from: number, to: number): string => {
  const buf = Buffer.alloc(Math.max(0, to - from));
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
};

const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  await promise;
};

const loadState = async (file: string): Promise<TailsState> => {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<TailsState>;
    return { offsets: parsed.offsets ?? {}, sessions: parsed.sessions ?? {} };
  } catch {
    return { offsets: {}, sessions: {} };
  }
};

const saveState = async (file: string, state: TailsState): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(state));
  await rename(`${file}.tmp`, file);
};

/** Run the bridge until `signal` aborts. Hub down at boot or mid-run is a retry loop, never an exit. */
export const runTails = async (opts: TailsOptions): Promise<void> => {
  const quietMs = opts.quietMs ?? OMP_SESSION_STALE_MS;
  const pollMs = opts.pollMs ?? 500;
  const retryMs = opts.retryMs ?? 2000;
  const startMs = opts.startMs ?? Date.now();
  const log = opts.log ?? (() => {});
  const state = await loadState(opts.stateFile);
  const tracked = new Map<string, Tracked>(); // sessionId → tracking
  const byPath = new Map<string, string>(); // path → sessionId

  // restore non-ended sessions from the previous run; ended ones stay ended (never re-announced)
  for (const [id, s] of Object.entries(state.sessions)) {
    const offset = state.offsets[s.path];
    if (offset === undefined) continue;
    tracked.set(id, { path: s.path, dir: s.path.split("/").at(-2) ?? "", offset, lastActivityMs: s.ended ? 0 : Date.now(), ended: s.ended });
    byPath.set(s.path, id);
  }

  const persist = async (): Promise<void> => {
    const next: TailsState = { offsets: {}, sessions: {} };
    for (const [id, t] of tracked) {
      next.offsets[t.path] = t.offset;
      next.sessions[id] = { path: t.path, ended: t.ended };
    }
    await saveState(opts.stateFile, next).catch(() => {});
  };

  const announce = (client: HubClient, id: string, t: Tracked): void => {
    const head = readRange(t.path, 0, Math.min(statSync(t.path).size, 64 * 1024));
    const lines = head.split("\n").map(parseLine).filter((l): l is TranscriptLine => l !== null);
    const title = declaredTitle(lines) || firstUserText(lines).slice(0, 80);
    client.report("session_start", { sessionId: id, kind: "peer", cwd: cwdFromDir(t.dir), model: modelFromLines(lines), attached: true, ...(title ? { title } : {}) });
  };

  const pump = (client: HubClient, id: string, t: Tracked): boolean => {
    let size: number;
    try {
      size = statSync(t.path).size;
    } catch {
      return false;
    }
    if (size < t.offset) t.offset = 0; // truncated/rotated
    if (size === t.offset) return false;
    const chunk = readRange(t.path, t.offset, size);
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) return false; // partial line: wait for the rest
    const complete = chunk.slice(0, lastNl + 1);
    if (t.ended) {
      announce(client, id, t); // activity after farewell: re-arm
      t.ended = false;
    }
    for (const raw of complete.split("\n")) {
      const line = parseLine(raw);
      if (!line) continue;
      for (const f of translate(id, line)) client.report(f.frame, f.payload);
    }
    t.offset += Buffer.byteLength(complete);
    t.lastActivityMs = Date.now();
    return true;
  };

  const tick = async (client: HubClient): Promise<void> => {
    let dirty = false;
    for (const f of listTranscripts(opts.sessionsRoot)) {
      if (byPath.has(f.path)) continue;
      if (f.mtimeMs < startMs) continue; // dead history is never announced
      const id = idFromName(f.name);
      const t: Tracked = { path: f.path, dir: f.dir, offset: 0, lastActivityMs: f.mtimeMs, ended: false };
      tracked.set(id, t);
      byPath.set(f.path, id);
      announce(client, id, t);
      dirty = true;
    }
    for (const [id, t] of tracked) {
      if (pump(client, id, t)) dirty = true;
      if (!t.ended && Date.now() - t.lastActivityMs >= quietMs) {
        client.report("agent_end", { sessionId: id, reason: "complete" });
        t.ended = true;
        dirty = true;
      }
    }
    if (dirty) await persist();
  };

  let wasDown = false;
  while (!opts.signal.aborted) {
    const r = await connectHubClient({ socketPath: opts.sock, client: "backfill", deadlineMs: 1000 });
    if (!r.ok) {
      if (!wasDown) log("hub unreachable — retrying every 2s");
      wasDown = true;
      await sleep(retryMs, opts.signal);
      continue;
    }
    wasDown = false;
    const client = r.value;
    const closed = Promise.withResolvers<void>();
    client.onClose(() => closed.resolve());
    let isClosed = false;
    void closed.promise.then(() => (isClosed = true));
    // attach-on-connect: re-announce every non-ended session
    for (const [id, t] of tracked) if (!t.ended) announce(client, id, t);
    while (!opts.signal.aborted && !isClosed) {
      await tick(client);
      await sleep(pollMs, opts.signal);
    }
    client.close();
    if (isClosed && !opts.signal.aborted) {
      log("hub unreachable — retrying every 2s");
      wasDown = true;
      await sleep(retryMs, opts.signal);
    }
  }
  await persist();
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("tails")
    .description("bridge omp transcripts into the hub as reporter frames until ctrl-c")
    .action(async () => {
      if (ctx.policy.machine) throw new CliError("usage", "tails has no --json/--ndjson mode: a bridge has no snapshot semantics");
      const { sock, dataRoot } = ctx.config;
      const { sessionsRoot } = resolveHubEnv({ ...process.env, OMP_HUB_SOCK: sock });
      process.stdout.write(`tails: watching ${sessionsRoot} → ${sock} (quiet-end ${OMP_SESSION_STALE_MS / 1000}s)\n`);

      const ac = new AbortController();
      const stop = (): void => ac.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await runTails({
        sock,
        sessionsRoot,
        stateFile: join(dataRoot, "tails-state.json"),
        signal: ac.signal,
        log: (line) => process.stderr.write(`${line}\n`),
      });
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
};
