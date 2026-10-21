// cli/src/stub_hub.ts — test harness: a stub hub on a TMP socket + a runner that spawns the real bin.
// Never touches ~/.hub: HOME and OMP_HUB_SOCK both point into a temp dir.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUnixSocketServer } from "@yurifrl/hub/adapters/unix_socket";
import type { CommandRequest } from "@yurifrl/hub";

export type StubReply = { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } };
export type StubHandler = (req: CommandRequest) => StubReply;

export type RunResult = { code: number; stdout: string; stderr: string };

export type StubHub = {
  home: string;
  sock: string;
  calls: CommandRequest[];
  run(cmd: string, args: string[], env?: Record<string, string>): Promise<RunResult>;
  close(): Promise<void>;
};

const RUNNER = join(import.meta.dir, "stub_runner.ts");

export const startStubHub = async (handlers: Record<string, StubHandler>): Promise<StubHub> => {
  const home = mkdtempSync(join(tmpdir(), "hubcli-"));
  const sock = join(home, "hub.sock");
  const calls: CommandRequest[] = [];
  const server = startUnixSocketServer({
    socketPath: sock,
    hubInfo: { version: 1, startedAt: "2026-10-21T00:00:00.000Z" },
    dispatch: async (req) => {
      calls.push(req);
      const h = handlers[req.op];
      if (!h) return { ok: false, error: { code: "denied", message: `stub: no handler for ${req.op}` } };
      return h(req);
    },
  });
  const started = await server.start();
  if (!started.ok) throw new Error(started.error.message);
  return {
    home,
    sock,
    calls,
    run: (cmd, args, env = {}) => runCli(cmd, args, { HOME: home, OMP_HUB_SOCK: sock, ...env }),
    close: async () => {
      await server.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    },
  };
};

/** Spawn `bun stub_runner.ts <cmd> <args>` with a scrubbed env (no inherited OMP_HUB_* / NO_COLOR surprises). */
export const runCli = async (cmd: string, args: string[], env: Record<string, string>): Promise<RunResult> => {
  const proc = Bun.spawn(["bun", RUNNER, cmd, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export const ROSTER = {
  hub: { version: 1, startedAt: "2026-10-21T00:00:00.000Z", pid: 1, nextAttentionId: 3 },
  sessions: {
    "aaaa1111-0000": { cwd: "/w/alpha", title: "alpha", phase: "idle", model: "m", kind: "worker" },
    "aaaa2222-0000": { cwd: "/w/beta", title: "beta", phase: "working", model: "m", kind: "worker" },
    "bbbb3333-0000": { cwd: "/w/gamma", title: "gamma", phase: "idle", model: "m", kind: "worker" },
  },
  attention: [
    { id: "a-1", sessionId: "aaaa1111-0000", kind: "question", text: "ok?" },
    { id: "a-2", sessionId: "bbbb3333-0000", kind: "question", text: "go?", resolvedAt: "2026-10-21T00:00:01.000Z" },
  ],
  archived: [],
};

export const listHandler: StubHandler = () => ({ ok: true, result: ROSTER });
