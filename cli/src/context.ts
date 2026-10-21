// cli/src/context.ts — the contract every command module receives.
// `config` and `policy` resolve lazily from the parsed global flags, so they are only
// valid inside an action handler (after commander has parsed argv).

import type { Command } from "commander";
import { connectHubClient, type HubClient } from "@yurifrl/hub/adapters/unix_socket";
import { resolveConfig, type HubCliConfig } from "./config";
import { CliError, fromHubError } from "./errors";
import { selectPolicy, type OutputPolicy } from "./output";

export type CliContext = {
  readonly config: HubCliConfig;
  readonly policy: OutputPolicy;
  /** Open hub.sock. Throws CliError (unavailable / protocol / timeout). Caller closes. */
  connect(opts?: { subscribe?: boolean }): Promise<HubClient>;
  /** One-shot cmd: connect, send one op, await the reply, close. Throws CliError. */
  call(op: string, args?: Record<string, unknown>, deadlineMs?: number): Promise<unknown>;
};

/** Every file in commands/ default-exports nothing and exports this. */
export type RegisterCommand = (program: Command, ctx: CliContext) => void;

type GlobalFlags = { config?: string; json?: boolean; ndjson?: boolean; color?: boolean };

export const createContext = (program: Command, env: Record<string, string | undefined>): CliContext => {
  let cached: { config: HubCliConfig; policy: OutputPolicy } | undefined;
  const resolved = () => {
    if (cached) return cached;
    const f = program.opts<GlobalFlags>();
    const config = resolveConfig({ ...(f.config !== undefined ? { configPath: f.config } : {}), env, noColorFlag: f.color === false });
    cached = { config, policy: selectPolicy(f, config.color) };
    return cached;
  };

  const connect: CliContext["connect"] = async (opts) => {
    const { config } = resolved();
    const r = await connectHubClient({
      socketPath: config.sock,
      client: "cli",
      deadlineMs: config.replyTimeoutMs,
      ...(opts?.subscribe ? { subscribe: true } : {}),
    });
    if (!r.ok) throw fromHubError(r.error);
    return r.value;
  };

  return {
    get config() {
      return resolved().config;
    },
    get policy() {
      return resolved().policy;
    },
    connect,
    async call(op, args = {}, deadlineMs) {
      const client = await connect();
      try {
        const r = await client.cmd(op, args, deadlineMs);
        if (!r.ok) throw fromHubError(r.error);
        return r.value;
      } finally {
        client.close();
      }
    },
  };
};

export { CliError };
