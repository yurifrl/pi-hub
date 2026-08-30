#!/usr/bin/env node
// G8: PLAN.md indexes the spec — references each doc, states DRY + hexagonal,
// filesystem layout, skills, agents, implementation detail.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const plan = readFileSync(join(root, "PLAN.md"), "utf8");

const requiredDocs = [
  "docs/01-architecture.md",
  "docs/02-data-contracts.md",
  "docs/03-cli.md",
  "docs/04-web.md",
  "docs/05-omp-plugin.md",
  "docs/06-agents-and-skills.md",
];
const missDocs = requiredDocs.filter((d) => !plan.includes(d));
if (missDocs.length) { console.error(`FAIL: PLAN.md missing doc links: ${missDocs.join(", ")}`); process.exit(1); }

const requiredTokens = [
  ["hexagonal", "architecture paradigm stated"],
  ["DRY", "DRY rule stated"],
  ["ports", "ports layer named"],
  ["adapters", "adapters layer named"],
  ["domain", "domain layer named"],
  ["skills/", "skills directory organized"],
  ["agents/", "agents directory named"],
  ["status.json", "data structures named"],
  ["hub.sock", "socket named"],
  ["hub_", "plugin tools named"],
  ["AttentionItem", "attention contract named"],
  ["@yurifrl/hub", "lib package name"],
  ["@yurifrl/hub-cli", "cli package name"],
  ["@yurifrl/hub-web", "web package name"],
];
const missing = requiredTokens.filter(([t]) => !plan.includes(t));
if (missing.length) { console.error(`FAIL: PLAN.md missing tokens: ${missing.map(([, t]) => t).join(", ")}`); process.exit(1); }
console.log("plan index verification passed (6 docs indexed, DRY/hexagonal/structure/skills/agents stated)");
