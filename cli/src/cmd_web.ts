// cli/src/cmd_web.ts — `hub web [--port P]` (docs/03-cli.md §Subcommands web):
// the CLI wrapper around the Hub Console (`@yurifrl/hub-web`, docs/04). This
// is the one sanctioned cli→web edge (recorded as an exception in docs/01
// §Import matrix): docs/03 names web as a subcommand, docs/04 names `hub web`
// as the server's host, and no middle package exists — a host here is
// composition, not business logic.
//
// Composition (docs/04 §Server: "the composition root injects stores, bus,
// and command surface"): adapters over ~/.hub via the lib barrel and
// sanctioned adapter subpaths — json_store reads status.json, jsonl_store
// tails summaries.jsonl + logs/<id>.jsonl, status attention store caches the
// list, memory_bus receives hub.sock event frames, and the CommandSurface is
// a hub.sock cmd client with by:"web". The web package itself holds no I/O.
//
// Lifecycle (docs/03 §web): foreground; TTY opens the browser (piped prints
// the URL); ctrl-c exits 0; `--json`/`--ndjson` → usage 1 (a server has no
// snapshot semantics); port busy → exit 2 with the port in the message.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJsonStore } from "@yurifrl/hub/adapters/json_store";
import { createJsonlStore } from "@yurifrl/hub/adapters/jsonl_store";
import { createStatusAttentionStore } from "@yurifrl/hub/adapters/attention_store";
import { connectHubClient } from "@yurifrl/hub/adapters/unix_socket";
import type {
  AttentionItem,
  AttentionStore,
  CommandReply,
  CommandSurface,
  EventBus,
  HubEvent,
  StatusStore,
  SummaryStore,
} from "@yurifrl/hub";
import type { HubArchiveEntry, HubArchiveRecord, HubWebArchive, HubWebLogs } from "@yurifrl/hub-web";
import { startHubWeb } from "@yurifrl/hub-web";
import type { CommandContext } from "./commands";
import { failWith } from "./cmd_mutation_helpers";

/** Bounded tail cap shared with the web snapshot renderer (docs/04 §Session
 * detail: LOG_MAX_LINES). Value mirrored from web/src/snapshot.ts — lib owns
 * no web shapes and cli may not import web internals beyond the barrel. */
const WEB_LOG_MAX_LINES = 400;

/** ~/.hub → web stores. web never reads files itself (docs/04 §Server). */
const buildStores = (ctx: CommandContext): { status: StatusStore; summaries: SummaryStore; attention: AttentionStore } => {
  const status = createJsonStore(ctx.config.dataRoot);
  const summaries = createJsonlStore(ctx.config.dataRoot);
  const attention = createStatusAttentionStore({ status, summaries, clock: { now: () => Date.now() }, selfIds: () => [] });
  return { status, summaries, attention };
};

/** The event bus: hub.sock event frames → HubEvent (docs/02 §Event frames),
 * the same decode vocabulary as cli/src/hub_events.ts (board and watch feed).
 * Web subscribes, never publishes state (docs/01 import matrix). */
const sockEventBus = (ctx: CommandContext): EventBus => {
  const subscribers = new Set<(evt: HubEvent) => void>();
  const topics: ReadonlySet<string> = new Set(["log", "status", "attention", "summary", "phase"]);
  const emit = (evt: HubEvent): void => {
    for (const fn of subscribers) {
      try {
        fn(evt);
      } catch {
        // a broken listener must not break the feed
      }
    }
  };
  void (async () => {
    const res = await connectHubClient({ socketPath: ctx.config.sock, client: "web", subscribe: true, deadlineMs: ctx.config.replyTimeoutMs });
    if (!res.ok) return; // hub down: the server still serves snapshots from disk
    res.value.onEvent((frame) => {
      const kind = typeof frame.kind === "string" ? frame.kind : "";
      if (!topics.has(kind)) return;
      // docs/02 §Event frames: attention wraps its item under `item`; the
      // five reporter-name frames carry their payload flat on the frame
      const payload = kind === "attention" ? frame.item : frame.payload ?? frame;
      emit({ topic: kind as HubEvent["topic"], payload });
    });
  })();
  return {
    publish: () => {}, // web never publishes state (docs/01 §Import matrix)
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
};

/** CommandSurface over the ctx.cmd one-shot client (docs/03 §bin: hub-backed
 * commands write one cmd frame and close). by:"web" per docs/02 §cmd frames —
 * hubCmd stamps it on the cmd frame so the hub attributes the resolution
 * envelope to the web surface. */
const sockCommands = (ctx: CommandContext): CommandSurface => ({
  dispatch: async (req): Promise<CommandReply> => {
    // by:"web" per docs/02 §cmd frames — the hub attributes the resolution
    // envelope to the web surface (summaries.jsonl `by` field)
    const out = await ctx.cmd(req.op, req.args, undefined, "web");
    return "result" in out
      ? { ok: true, value: out.result }
      : { ok: false, error: { code: "denied", message: out.error.message, retryable: false } };
  },
  ops: () => ["answer", "assign", "send", "attention"],
});

/** Log tail port over logs/<id>.jsonl (docs/04 §Server: "satisfied by
 * injecting the lib jsonl_store adapter"). Missing file → empty tail, the
 * adapter's own ENOENT semantics. */
const fileLogs = (ctx: CommandContext): HubWebLogs => {
  const store = createJsonlStore(ctx.config.dataRoot);
  return {
    tail: async (id) => {
      const res = await store.tailLog(id, WEB_LOG_MAX_LINES);
      return res.ok ? res.value : [];
    },
  };
};
const fileArchive = (ctx: CommandContext): HubWebArchive => {
  const months = (): string[] => {
    try {
      return readdirSync(join(ctx.config.dataRoot, "archive")).sort().reverse();
    } catch {
      return [];
    }
  };
  const readRecord = (path: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  return {
    list: async (): Promise<HubArchiveEntry[]> => {
      const out: HubArchiveEntry[] = [];
      for (const month of months()) {
        let files: string[];
        try {
          files = readdirSync(join(ctx.config.dataRoot, "archive", month));
        } catch {
          continue; // a vanished month degrades
        }
        for (const f of files.sort().reverse()) {
          if (!f.endsWith(".json")) continue;
          const raw = readRecord(join(ctx.config.dataRoot, "archive", month, f));
          if (raw === null) continue;
          out.push({
            id: typeof raw.id === "string" ? raw.id : f.replace(/\.json$/, ""),
            closedAt: typeof raw.closedAt === "string" ? raw.closedAt : "",
            closedBy: typeof raw.closedBy === "string" ? raw.closedBy : "",
            finalSummary: typeof raw.finalSummary === "string" ? raw.finalSummary : "",
            path: `archive/${month}/${f}`,
          });
        }
      }
      return out.sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0));
    },
    read: async (id): Promise<HubArchiveRecord | null> => {
      for (const entry of await fileArchive(ctx).list()) {
        if (entry.id !== id) continue;
        const raw = readRecord(join(ctx.config.dataRoot, entry.path));
        if (raw === null) return null;
        const { closedAt, closedBy, finalSummary, resolutions, ...rest } = raw;
        const record = rest as unknown as HubArchiveRecord["record"];
        return {
          id,
          record,
          closedAt: typeof closedAt === "string" ? closedAt : "",
          closedBy: typeof closedBy === "string" ? closedBy : "",
          finalSummary: typeof finalSummary === "string" ? finalSummary : "",
          resolutions: Array.isArray(resolutions) ? (resolutions as AttentionItem[]) : [],
        };
      }
      return null;
    },
  };
};

/** Open the browser on the console URL (TTY only, docs/03 §web). BROWSER env
 * overrides; detached so the server is not the browser's parent. */
const openBrowser = (url: string): void => {
  const browser = process.env.BROWSER;
  if (browser === undefined || browser === "") return;
  try {
    const child = spawn(browser, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // browser launch is best-effort; the URL is already printed
  }
};

export const cmdWeb = async (ctx: CommandContext, portFlag: number | undefined): Promise<void> => {
  // machine modes → usage, exit 1 (docs/03 §web: a server has no snapshot
  // semantics)
  if (ctx.policy.format !== "human") {
    return failWith(ctx, "usage", "web: a server has no snapshot semantics; run without --json/--ndjson");
  }

  const port = portFlag ?? ctx.config.webPort;
  let started: { stop(): Promise<void>; port: number };
  try {
    started = await startHubWeb({
      port,
      stores: buildStores(ctx),
      bus: sockEventBus(ctx),
      commands: sockCommands(ctx),
      logs: fileLogs(ctx),
      archive: fileArchive(ctx),
    });
  } catch (e) {
    // Bun.serve throws EADDRINUSE on a busy port (docs/03: exit 2 with the
    // port in the message)
    return failWith(ctx, "unavailable", `web: cannot bind 127.0.0.1:${port} — ${(e as Error).message}`);
  }

  const url = `http://127.0.0.1:${started.port}`;
  const stdoutIsTty = ctx.io.stdout === process.stdout ? process.stdout.isTTY === true : false;
  if (stdoutIsTty) {
    ctx.io.stdout.write(`✓ hub console on ${url}\n`);
    openBrowser(url);
  } else {
    ctx.io.stdout.write(`${url}\n`);
  }

  // follower: runs until the process is signaled (docs/03 §Signals: SIGINT /
  // SIGTERM restore and exit 0 — stopping a viewer is not an error)
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      for (const sig of signals) process.off(sig, stop);
      void started.stop().then(resolve);
    };
    for (const sig of signals) process.on(sig, stop);
  });
  process.exitCode = 0;
};
