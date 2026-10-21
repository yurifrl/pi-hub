// hub web [--port P] — serve the Hub Console (@yurifrl/hub-web) in the foreground.
// Reads stores straight from the data root; writes and live events go through hub.sock.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OP_NAMES, type CommandReply, type CommandRequest, type HubEvent } from "@yurifrl/hub";
import { createMemoryBus } from "@yurifrl/hub/adapters/memory_bus";
import { createJsonStore } from "@yurifrl/hub/adapters/json_store";
import { createJsonlStore } from "@yurifrl/hub/adapters/jsonl_store";
import { createStatusAttentionStore } from "@yurifrl/hub/adapters/attention_store";
import { startHubWeb, type HubArchiveEntry, type HubArchiveRecord, type HubWebArchive } from "@yurifrl/hub-web";
import type { CliContext, RegisterCommand } from "../context";
import { CliError } from "../errors";

const LOG_KINDS: Record<string, true> = { session_start: true, user_message: true, assistant_message: true, tool_call: true, agent_end: true };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Event frame (docs/02 §Event frames) → HubEvent for the web bus. Malformed frames yield null. */
export const frameToHubEvent = (frame: Record<string, unknown>, now: () => number = Date.now): HubEvent | null => {
  const kind = str(frame.kind);
  if (kind === undefined) return null;
  if (kind === "attention") {
    return frame.item && typeof frame.item === "object" ? { topic: "attention", payload: frame.item } : null;
  }
  if (kind === "phase") {
    const sessionId = str(frame.sessionId);
    const phase = str(frame.phase);
    if (sessionId === undefined || phase === undefined) return null;
    return { topic: "phase", payload: { sessionId, phase, at: frame.at } };
  }
  if (!Object.hasOwn(LOG_KINDS, kind)) return null;
  const sessionId = str(frame.sessionId);
  if (sessionId === undefined) return null;
  const text =
    kind === "tool_call" ? (str(frame.tool) ?? "") : kind === "session_start" ? (str(frame.title) ?? "session started") : (str(frame.text) ?? str(frame.reason) ?? kind);
  return { topic: "log", payload: { t: now(), sessionId, kind, text } };
};

const archiveReader = (dataRoot: string): HubWebArchive => {
  const files = async (): Promise<Array<{ id: string; path: string }>> => {
    const root = join(dataRoot, "archive");
    const out: Array<{ id: string; path: string }> = [];
    let months: string[];
    try {
      months = await readdir(root);
    } catch {
      return out;
    }
    for (const month of months) {
      let names: string[] = [];
      try {
        names = await readdir(join(root, month));
      } catch {
        continue;
      }
      for (const n of names) if (n.endsWith(".json")) out.push({ id: n.slice(0, -5), path: join("archive", month, n) });
    }
    return out;
  };
  const load = async (rel: string): Promise<Record<string, unknown> | null> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dataRoot, rel), "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    async list() {
      const out: HubArchiveEntry[] = [];
      for (const f of await files()) {
        const r = await load(f.path);
        if (!r) continue;
        out.push({ id: f.id, closedAt: str(r.closedAt) ?? "", closedBy: str(r.closedBy) ?? "", finalSummary: str(r.finalSummary) ?? "", path: f.path });
      }
      return out.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
    },
    async read(id) {
      const f = (await files()).find((x) => x.id === id);
      const r = f ? await load(f.path) : null;
      if (!f || !r) return null;
      const { closedAt, closedBy, finalSummary, resolutions, ...rest } = r;
      return {
        id,
        record: rest as unknown as HubArchiveRecord["record"],
        closedAt: str(closedAt) ?? "",
        closedBy: str(closedBy) ?? "",
        finalSummary: str(finalSummary) ?? "",
        resolutions: Array.isArray(resolutions) ? (resolutions as HubArchiveRecord["resolutions"]) : [],
      };
    },
  };
};

const openBrowser = (url: string): void => {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // no opener available: the URL was already printed
  }
};

const startWeb = async (ctx: CliContext, port: number) => {
  const { dataRoot } = ctx.config;
  const status = createJsonStore(dataRoot);
  const jsonl = createJsonlStore(dataRoot);
  const bus = createMemoryBus();
  const commands = {
    async dispatch(req: CommandRequest): Promise<CommandReply> {
      try {
        return { ok: true, value: await ctx.call(req.op, req.args) };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const retryable = e instanceof CliError && (e.code === "unavailable" || e.code === "timeout");
        return { ok: false, error: { code: e instanceof CliError && e.code === "unavailable" ? "unavailable-hub" : "denied", message, retryable } };
      }
    },
    ops: () => [...OP_NAMES],
  };
  try {
    return await startHubWeb({
      port,
      stores: { status, summaries: jsonl, attention: createStatusAttentionStore({ status, summaries: jsonl, clock: { now: Date.now } }) },
      bus,
      commands,
      logs: {
        async tail(id) {
          const r = await jsonl.tailLog(id, 500);
          return r.ok ? r.value : [];
        },
      },
      archive: archiveReader(dataRoot),
    }).then((web) => ({ web, bus }));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String((e as Error).message))) {
      throw new CliError("unavailable", `port ${port} busy (127.0.0.1)`);
    }
    throw new CliError("unavailable", `hub web failed on port ${port}: ${(e as Error).message}`);
  }
};

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("web")
    .description("serve the Hub Console on 127.0.0.1 until ctrl-c")
    .option("--port <port>", "listen port (default: config webPort)")
    .action(async (opts: { port?: string }) => {
      if (ctx.policy.machine) throw new CliError("usage", "web has no --json/--ndjson mode: a server has no snapshot semantics");
      const port = opts.port === undefined ? ctx.config.webPort : Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError("usage", `invalid --port ${opts.port}`);

      const { web, bus } = await startWeb(ctx, port);
      const url = `http://127.0.0.1:${web.port}`;
      process.stdout.write(`hub web on ${url}\n`);
      if (process.stdout.isTTY) openBrowser(url);

      // live deltas: bridge hub.sock event frames onto the web bus; best-effort, retried quietly
      let closing = false;
      let current: { close(): void } | undefined;
      const bridge = async (): Promise<void> => {
        while (!closing) {
          const closed = Promise.withResolvers<void>();
          try {
            const client = await ctx.connect({ subscribe: true });
            current = client;
            client.onEvent((frame) => {
              const evt = frameToHubEvent(frame);
              if (evt) bus.publish(evt);
            });
            client.onClose(() => closed.resolve());
            await closed.promise;
          } catch {
            // hub down: the console still serves stored state
          }
          if (!closing) {
            const pause = Promise.withResolvers<void>();
            setTimeout(pause.resolve, 2000);
            await pause.promise;
          }
        }
      };
      void bridge();

      const stopped = Promise.withResolvers<void>();
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
      const stop = (): void => {
        closing = true;
        for (const sig of signals) process.off(sig, stop);
        current?.close();
        void web.stop().then(stopped.resolve, stopped.resolve);
      };
      for (const sig of signals) process.on(sig, stop);
      await stopped.promise;
    });
};
