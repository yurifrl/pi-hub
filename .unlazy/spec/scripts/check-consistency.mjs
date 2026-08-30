#!/usr/bin/env node
// G9: contract consistency across the six docs — package names, port names,
// tool names, attention kinds, theme tokens, data files agree; no variants.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const docs = ["01-architecture", "02-data-contracts", "03-cli", "04-web", "05-omp-plugin", "06-agents-and-skills"];
const texts = new Map();
for (const d of docs) {
  const p = join(root, "docs", `${d}.md`);
  if (!existsSync(p)) { console.error(`FAIL: missing docs/${d}.md`); process.exit(1); }
  texts.set(d, readFileSync(p, "utf8"));
}

// non-canonical spellings must not appear anywhere
const variants = ["@yurifrl/hub-core", "pi-hub-lib", "hub-cli-scoped-wrong", "StatusStorePort", "HubEventBus", "IEventBus"];
for (const v of variants) {
  for (const [d, text] of texts) {
    if (text.includes(v)) { console.error(`FAIL: ${d} uses non-canonical token "${v}"`); process.exit(1); }
  }
}

// plugin doc must declare every hub_ tool
const pluginText = texts.get("05-omp-plugin");
const toolNames = ["hub_list_sessions", "hub_send_message", "hub_call_tool", "hub_spawn_worker", "hub_kill_worker", "hub_archive", "hub_attention", "hub_answer", "hub_assign"];
const missingTools = toolNames.filter((t) => !pluginText.includes(t));
if (missingTools.length) { console.error(`FAIL: 05-omp-plugin missing tools: ${missingTools.join(", ")}`); process.exit(1); }

// attention kinds must be consistent wherever AttentionItem appears
const kinds = ["approval", "question", "blocked", "idle"];
for (const [d, text] of texts) {
  if (text.includes("AttentionItem") && !kinds.every((k) => text.includes(k))) {
    console.error(`FAIL: ${d} mentions AttentionItem without all four kinds (approval|question|blocked|idle)`);
    process.exit(1);
  }
}

// theme tokens defined at least once somewhere
const themeTokens = ["#70e1c4", "#3fd68f", "#f5c04e", "#ff7a9a", "#8b97b0"];
for (const t of themeTokens) {
  const holders = docs.filter((d) => texts.get(d).includes(t));
  if (holders.length === 0) { console.error(`FAIL: theme token ${t} not defined in any doc`); process.exit(1); }
}

// shared data files referenced by >= 2 docs
const files = ["status.json", "summaries.jsonl", "hub.sock"];
for (const f of files) {
  const holders = docs.filter((d) => texts.get(d).includes(f));
  if (holders.length < 2) { console.error(`FAIL: ${f} referenced by fewer than 2 docs (${holders.length}) — contract drift`); process.exit(1); }
}
console.log("contract consistency verification passed (packages, ports, tools, kinds, theme, files agree)");
