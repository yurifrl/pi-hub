// cli/src/config.ts — HubCliConfig resolution, first hit wins (docs/03-cli.md §bin):
// 1) --config file  2) env  3) ~/.hub/config.json  4) built-in defaults.
// Pure-ish module: fs touches only through node:fs against explicit paths.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface HubCliConfig {
  sock: string; // default ~/.hub/hub.sock; env OMP_HUB_SOCK
  dataRoot: string; // default ~/.hub
  replyTimeoutMs: number; // default 10000; expiry maps to exit code 3
  webPort: number; // default 4820
  spawnModel: string; // default "" (hub picks); env OMP_HUB_MODEL
  ompBin: string; // default "omp"; env OMP_BIN
  color: boolean; // default true; false when NO_COLOR set or --no-color
}

export const DATA_ROOT_DEFAULT = join(homedir(), ".hub");

export type ConfigInputs = {
  configPath?: string; // --config <path>
  env?: NodeJS.ProcessEnv;
  argv?: string[]; // full argv — --no-color / NO_COLOR affect color before file loads
};

/** Parse and validate one config file body into partial overrides. */
const parseConfigFile = (name: string, content: string): Partial<HubCliConfig> => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new ConfigError(`--config ${name} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`--config ${name} must be a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length === 0) throw new ConfigError(`--config ${name}: "${k}" must be a non-empty string`);
    return v;
  };
  const num = (k: string): number | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ConfigError(`--config ${name}: "${k}" must be a positive number`);
    return v;
  };
  const bool = (k: string): boolean | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") throw new ConfigError(`--config ${name}: "${k}" must be a boolean`);
    return v;
  };
  const sock = str("sock");
  const dataRoot = str("dataRoot");
  const replyTimeoutMs = num("replyTimeoutMs");
  const webPort = num("webPort");
  const spawnModel = str("spawnModel");
  const ompBin = str("ompBin");
  const color = bool("color");
  return {
    ...(sock !== undefined ? { sock } : {}),
    ...(dataRoot !== undefined ? { dataRoot } : {}),
    ...(replyTimeoutMs !== undefined ? { replyTimeoutMs } : {}),
    ...(webPort !== undefined ? { webPort } : {}),
    ...(spawnModel !== undefined ? { spawnModel } : {}),
    ...(ompBin !== undefined ? { ompBin } : {}),
    ...(color !== undefined ? { color } : {}),
  };
};

/** Usage-class failure raised by config resolution; bin maps it to exit 1. */
export class ConfigError extends Error {}

export const resolveConfig = (inputs: ConfigInputs = {}): HubCliConfig => {
  const env = inputs.env ?? process.env;

  // defaults — ~/.hub tree
  const defaults: HubCliConfig = {
    sock: join(DATA_ROOT_DEFAULT, "hub.sock"),
    dataRoot: DATA_ROOT_DEFAULT,
    replyTimeoutMs: 10_000,
    webPort: 4820,
    spawnModel: "", // empty = hub picks the model
    ompBin: "omp",
    color: true,
  };

  // 3) ~/.hub/config.json — absent is NOT an error
  let file: Partial<HubCliConfig> = {};
  const userFile = join(DATA_ROOT_DEFAULT, "config.json");
  if (existsSync(userFile)) {
    try {
      file = parseConfigFile(userFile, readFileSync(userFile, "utf8"));
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`unreadable ${userFile}: ${(e as Error).message}`);
    }
  }

  // 2) env overrides
  const envOverrides: Partial<HubCliConfig> = {
    ...(env.OMP_HUB_SOCK ? { sock: env.OMP_HUB_SOCK } : {}),
    ...(env.OMP_HUB_MODEL ? { spawnModel: env.OMP_HUB_MODEL } : {}),
    ...(env.OMP_BIN ? { ompBin: env.OMP_BIN } : {}),
    ...(env.NO_COLOR ? { color: false } : {}),
  };

  // 1) --config file, explicit path — missing/unreadable IS an error (usage)
  const explicit = inputs.configPath;
  const explicitOverrides = explicit
    ? (() => {
        if (!existsSync(explicit)) throw new ConfigError(`--config ${explicit}: no such file`);
        let content: string;
        try {
          content = readFileSync(explicit, "utf8");
        } catch (e) {
          throw new ConfigError(`--config ${explicit}: unreadable (${(e as Error).message})`);
        }
        return parseConfigFile(explicit, content);
      })()
    : {};

  const merged: HubCliConfig = { ...defaults, ...file, ...envOverrides, ...explicitOverrides };

  // --no-color (parsed from argv here so config stays the single color authority)
  if (inputs.argv?.includes("--no-color")) merged.color = false;

  return merged;
};
