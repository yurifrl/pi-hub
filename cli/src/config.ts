// cli/src/config.ts — HubCliConfig resolution (spec §bin → Config):
// --config file > environment > ~/.hub/config.json > defaults. First hit wins per key.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";

export interface HubCliConfig {
  sock: string;
  dataRoot: string;
  replyTimeoutMs: number;
  webPort: number;
  spawnModel: string;
  ompBin: string;
  color: boolean;
}

export type ConfigInputs = {
  configPath?: string;
  env: Record<string, string | undefined>;
  noColorFlag: boolean;
  home?: string;
};

const readFileConfig = (path: string, mustExist: boolean): Partial<HubCliConfig> => {
  if (!existsSync(path)) {
    if (mustExist) throw new CliError("usage", `--config ${path}: file not found`);
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CliError("usage", `--config ${path}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CliError("usage", `${path} must be a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const out: Partial<HubCliConfig> = {};
  const str = (k: "sock" | "dataRoot" | "spawnModel" | "ompBin"): void => {
    const v = o[k];
    if (v === undefined) return;
    if (typeof v !== "string" || v === "") throw new CliError("usage", `${path}: "${k}" must be a non-empty string`);
    out[k] = v;
  };
  const num = (k: "replyTimeoutMs" | "webPort"): void => {
    const v = o[k];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new CliError("usage", `${path}: "${k}" must be a positive number`);
    out[k] = v;
  };
  str("sock");
  str("dataRoot");
  str("spawnModel");
  str("ompBin");
  num("replyTimeoutMs");
  num("webPort");
  if (o.color !== undefined) {
    if (typeof o.color !== "boolean") throw new CliError("usage", `${path}: "color" must be a boolean`);
    out.color = o.color;
  }
  return out;
};

export const resolveConfig = (inputs: ConfigInputs): HubCliConfig => {
  const home = inputs.home ?? homedir();
  const dataRoot = join(home, ".hub");
  const defaults: HubCliConfig = {
    sock: join(dataRoot, "hub.sock"),
    dataRoot,
    replyTimeoutMs: 10_000,
    webPort: 4820,
    spawnModel: "",
    ompBin: "omp",
    color: true,
  };
  const { env } = inputs;
  const fromEnv: Partial<HubCliConfig> = {};
  if (env.OMP_HUB_SOCK) fromEnv.sock = env.OMP_HUB_SOCK;
  if (env.OMP_HUB_MODEL) fromEnv.spawnModel = env.OMP_HUB_MODEL;
  if (env.OMP_BIN) fromEnv.ompBin = env.OMP_BIN;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") fromEnv.color = false;

  const fromFile = readFileConfig(join(dataRoot, "config.json"), false);
  const explicit = inputs.configPath !== undefined ? readFileConfig(inputs.configPath, true) : {};

  const merged: HubCliConfig = { ...defaults, ...fromFile, ...fromEnv, ...explicit };
  if (inputs.noColorFlag) merged.color = false;
  return merged;
};
