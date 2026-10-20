// cli/src/cmd_tails.ts — `hub tails` (companion to docs/03 §Subcommands):
// the transcript-tail bridge. Feeds the hub sessions that cannot report
// themselves — omp TUI sessions started before the hub plugin existed (the
// plugin loads at session start; a running session never re-reads it). Reads
// ~/.omp/agent/sessions/<dir>/<name>.jsonl, translates transcript lines into
// the docs/02 §Reporter wire frames, and ships them over hub.sock exactly
// like any other client (docs/02: the hub does not distinguish clients).
//
// Contract:
// - fresh discovery starts at the transcript tail (last 128 KiB) — announce
//   with the current phase, never replay history;
// - discovery is limited to files touched since the scan started (mtime
//   newer than boot) so September's archive of dead transcripts never floods
//   the board (the live run proved 839 zombie rows in one pass);
// - one trailing agent_end per session after END_QUIET_MS of transcript
//   silence (the watcher's debounce then writes the summary + flips idle);
//   a later line flips the session back to working by itself;
// - sessionId = trailing UUID of the transcript filename; cwd derived from
//   the session directory name (omp's "-Users-yuri-…" path flattening);
// - state persists in ~/.hub/tails-state.json: restarts resume offsets, and
//   sessions are re-announced after a hub restart (attach-on-connect, same
//   contract as the plugin reporter docs/05 §Anti-recursion guard 4).
//
// Lifecycle: foreground like `hub web`; ctrl-c exits 0. `--json`/`--ndjson`
// → usage 1 (a tail has no snapshot semantics). hub.sock down → exit 2.

import { readdirSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectHubClient, type HubClient } from "@yurifrl/hub/adapters/unix_socket";
import type { CommandContext } from "./commands";
import { failWith } from "./cmd_mutation_helpers";

const SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");
const SCAN_MS = 5_000;
const END_QUIET_MS = 40_000;
const TAIL_BYTES = 128 * 1024;
const STATE_VERSION = 1;

// ---- transcript line → reporter frame --------------------------------------

type TranscriptLine = {
  type?: string;
  customType?: string;
  data?: Record<string, unknown>;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
  };
};

const textOf = (message: TranscriptLine["message"]): string =>
  (message?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");

const clip = (s: string, n = 160): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** sessionId = trailing UUID of the transcript filename "…_<uuid>.jsonl". */
const idFromName = (name: string): string => {
  const m = /_([0-9a-f-]{36})\.jsonl$/.exec(name);
  return m ? m[1] : name.replace(/\.jsonl$/, "");
};

/** cwd from the session directory name: omp flattens paths with "-" and
 * strips the leading slash ("-Users-yuri-.omp-wt-…" → /Users/yuri/.omp/wt/…). */
const cwdFromDir = (dir: string): string => dir.replace(/^-/, "/").replace(/-/g, "/");

/** One reporter frame per transcript line; [] when the line carries no signal.
 * Same mapping the plugin reporter uses (docs/05 §Reporter table), derived
 * from the transcript instead of live extension events. */
const translate = (line: TranscriptLine): Array<Record<string, unknown>> => {
  const msg = line.message;
  const role = msg?.role;
  if (line.type === "message" && role === "user") {
    const text = clip(textOf(msg));
    return text ? [{ frame: "user_message", text }] : [];
  }
  if (line.type === "message" && role === "assistant") {
    const frames: Array<Record<string, unknown>> = [];
    const text = textOf(msg);
    if (text) frames.push({ frame: "assistant_message", text: clip(text) });
    for (const c of msg?.content ?? []) {
      if (c.type === "toolCall") frames.push({ frame: "tool_call", tool: c.name ?? "", args: c.arguments ?? {} });
    }
    return frames;
  }
  if (line.type === "custom" && line.customType === "tool_execution_start") {
    const d = line.data as { toolName?: string; args?: unknown } | undefined;
    return d?.toolName ? [{ frame: "tool_call", tool: d.toolName, args: d.args ?? {} }] : [];
  }
  return [];
};

// ---- state ------------------------------------------------------------------

type SessionState = {
  offset: number;
  sessionId: string;
  cwd: string;
  /** epoch ms of the newest translated line; 0 before the first line */
  lastLineAt: number;
  /** trailing agent_end already sent after the last quiet window */
  ended: boolean;
};

type TailsState = { version: number; sessions: Record<string, SessionState> };

/** One file scan per tick; entries are stat metadata per transcript file. */
type ScanEntry = { key: string; path: string; dir: string; name: string; mtimeMs: number; size: number };

const loadState = async (path: string): Promise<TailsState> => {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as TailsState;
    if (parsed.version === STATE_VERSION && parsed.sessions && typeof parsed.sessions === "object") {
      // ended defaulted false for older states
      for (const st of Object.values(parsed.sessions)) st.ended ??= false;
      return parsed;
    }
  } catch {
    /* first run */
  }
  return { version: STATE_VERSION, sessions: {} };
};

const saveState = async (path: string, state: TailsState): Promise<void> => {
  // atomic tmp+rename per docs/02 §Atomic rewrite
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, path);
};

/** Directory scan: every session dir's *.jsonl transcript with stat metadata.
 * One readdir + stat per file; ~1k files is cheap at the 5s cadence. */
const scanTranscripts = (): ScanEntry[] => {
  const out: ScanEntry[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(SESSIONS_DIR);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const dirPath = join(SESSIONS_DIR, dir);
    let names: string[];
    try {
      names = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dirPath, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        out.push({ key: `${dir}/${name}`, path, dir, name, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        continue;
      }
    }
  }
  return out;
};

// ---- the bridge body ---------------------------------------------------------

export const cmdTails = async (ctx: CommandContext): Promise<void> => {
  if (ctx.policy.format !== "human") {
    return failWith(ctx, "usage", "tails: a tail has no snapshot semantics — run it in a terminal");
  }

  const statePath = join(homedir(), ".hub", "tails-state.json");
  const state = await loadState(statePath);
  const bootMs = Date.now();

  let cli: HubClient | null = null;
  let closing = false;

  const write = (line: string): void => ctx.io.stdout.write(`${line}\n`);

  const wire = (client: HubClient): void => {
    client.onClose(() => {
      if (cli === client) cli = null;
      if (!closing) {
        write("hub.sock closed — reconnecting…");
        setTimeout(() => void reconnect(), 2_000);
      }
    });
  };

  const reconnect = async (): Promise<void> => {
    if (closing || cli) return;
    const res = await connectHubClient({ socketPath: ctx.config.sock, client: "backfill" });
    if (res.ok) {
      cli = res.value;
      wire(cli);
      for (const st of Object.values(state.sessions)) if (st.sessionId && !st.ended) announce(st);
    } else {
      setTimeout(() => void reconnect(), 2_000);
    }
  };

  const announce = (st: SessionState): void => {
    cli?.report("session_start", {
      sessionId: st.sessionId,
      kind: "peer",
      cwd: st.cwd,
      model: "",
      attached: true,
      title: st.sessionId.slice(0, 8),
    });
  };

  const send = (st: SessionState, frame: Record<string, unknown>): void => {
    cli?.report(frame.frame as string, { sessionId: st.sessionId, ...frame });
  };

  const readIncrement = async (path: string, st: SessionState, size: number): Promise<void> => {
    if (size <= st.offset) return;
    let buf = new TextDecoder().decode(await Bun.file(path).slice(st.offset).arrayBuffer());
    if (!buf.endsWith("\n")) {
      const i = buf.lastIndexOf("\n");
      if (i < 0) return; // one partial line only; wait for the next write
      buf = buf.slice(0, i + 1);
    }
    st.offset += buf.length;
    st.lastLineAt = Date.now();
    for (const raw of buf.split("\n")) {
      if (!raw) continue;
      try {
        for (const frame of translate(JSON.parse(raw) as TranscriptLine)) send(st, frame);
      } catch {
        /* skip unparseable line */
      }
    }
  };

  const scan = async (): Promise<void> => {
    if (!cli) return;
    const now = Date.now();
    const entries = scanTranscripts();
    let dirty = false;
    for (const e of entries) {
      let st = state.sessions[e.key];
      if (!st) {
        if (e.mtimeMs < bootMs) continue; // untouched since boot — dead history
        st = {
          offset: Math.max(0, e.size - TAIL_BYTES),
          sessionId: idFromName(e.name),
          cwd: cwdFromDir(e.dir),
          lastLineAt: 0,
          ended: false,
        };
        state.sessions[e.key] = st;
        announce(st);
        dirty = true;
      }
      await readIncrement(e.path, st, e.size).catch(() => undefined);
      if (st.lastLineAt > 0 && !st.ended && now - st.lastLineAt > END_QUIET_MS) {
        st.ended = true;
        send(st, { frame: "agent_end", reason: "complete" });
        dirty = true;
      } else if (st.ended && st.lastLineAt > 0 && now - st.lastLineAt <= END_QUIET_MS) {
        st.ended = false; // activity resumed after the quiet-end
        dirty = true;
      }
    }
    if (dirty) await saveState(statePath, state).catch(() => undefined);
  };

  const tick = async (): Promise<void> => {
    if (closing) return;
    await scan();
    setTimeout(() => void tick(), SCAN_MS);
  };

  const stop = (): void => {
    closing = true;
    cli?.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  write(`tails: watching ${SESSIONS_DIR} → ${ctx.config.sock} (quiet-end ${END_QUIET_MS / 1000}s)`);
  // hub down at boot is normal (bridge starts before/alongside the hub):
  // hold the process and let reconnect() retry every 2s — failWith would end
  // the bridge exactly when the hub needs to be started (docs/03 §tails).
  const first = await connectHubClient({ socketPath: ctx.config.sock, client: "backfill" });
  if (first.ok) {
    cli = first.value;
    wire(cli);
  } else {
    write(`hub unreachable — retrying every 2s`);
    setTimeout(() => void reconnect(), 2_000);
  }
  await tick();

  // hold until interrupted
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (closing) {
        clearInterval(check);
        resolve();
      }
    }, 250);
  });
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
};
