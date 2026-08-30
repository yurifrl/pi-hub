#!/usr/bin/env node
// Doc gate checker for pi-hub spec. Usage: node check-doc.mjs <id>
// Asserts: file exists, dense (>=5KB), required sections present,
// required contract tokens present, no runnable implementation code.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs");

const MODULES = {
  "01-architecture": {
    headers: ["## Architecture", "## Package layout", "## Module boundaries", "## Core abstractions", "## Error model", "## Testing", "## Conventions"],
    tokens: ["@yurifrl/pi-hub", "@yurifrl/hub", "@yurifrl/hub-cli", "@yurifrl/hub-web", "StatusStore", "EventBus", "AttentionStore", "CommandSurface", "ports", "domain", "adapters", "DRY", "hexagonal", "Result"],
    minKb: 6,
  },
  "02-data-contracts": {
    headers: ["## status.json", "## logs", "## summaries.jsonl", "## archive", "## hub.sock", "## Attention", "## Versioning"],
    tokens: ["sessionId", "attention", "approval", "question", "blocked", "idle", "closedAt", "finalSummary", "status.json", "summaries.jsonl", "archive", "hub.sock", "version", "atomic"],
    minKb: 5,
  },
  "03-cli": {
    headers: ["# hub CLI", "## bin", "## hub (bare)", "## Subcommands", "## Rendering", "## Output", "## Sketches"],
    tokens: ["hub", "answer", "assign", "log", "summaries", "send", "tool", "spawn", "kill", "archive", "watch", "agent", "web", "--json", "--ndjson", "ANSI", "exit code"],
    minKb: 5,
  },
  "04-web": {
    headers: ["# Hub Console", "## Routes", "## SSE", "## Main page", "## Session detail", "## Agent page", "## Server", "## Wireframes"],
    tokens: ["/api/answer", "/api/assign", "/api/send", "/api/dismiss", "/stream", "snapshot", "attention", "127.0.0.1", "SSE", "Last-Event-ID"],
    minKb: 5,
  },
  "05-omp-plugin": {
    headers: ["# omp plugin", "## Entry", "## Reporter", "## Tools", "## Widget", "## Agent spawn", "## Shutdown", "## Env vars"],
    tokens: ["hub_list_sessions", "hub_send_message", "hub_call_tool", "hub_spawn_worker", "hub_kill_worker", "hub_archive", "hub_attention", "hub_answer", "hub_assign", "OMP_HUB_SOCK", "OMP_HUB_BRAIN", "OMP_HUB_MODEL", "setWidget", "attached"],
    minKb: 6,
  },
  "06-agents-and-skills": {
    headers: ["# Agents", "## Hub agent", "## agentSurface", "## Skills", "## Agent files", "## Interaction flows", "## Cadence"],
    tokens: ["hub-watcher", "hub-ops", "SKILL.md", "agents/hub-watcher.md", "surface.json", "watcher", "pending", "AttentionItem", "summaries.jsonl", "status.json"],
    minKb: 5,
  },
};

const id = process.argv[2];
if (!id) { console.error("usage: check-doc.mjs <module-id>"); process.exit(2); }
const path = join(root, `${id}.md`);
if (!existsSync(path)) { console.error(`FAIL: missing ${path}`); process.exit(1); }
const size = statSync(path).size;
if (size < MODULES[id].minKb * 1024) { console.error(`FAIL: ${id} too small (${(statSync(path).size / 1024).toFixed(1)}KB, need >= ${MODULES[id].minKb}KB of dense spec)`); process.exit(1); }
const text = readFileSync(path, "utf8");
const missing = MODULES[id].headers.filter((h) => !text.includes(h));
if (missing.length) { console.error(`FAIL: ${id} missing sections: ${missing.join("; ")}`); process.exit(1); }
const missingTokens = MODULES[id].tokens.filter((t) => !text.includes(t));
if (missingTokens.length) { console.error(`FAIL: ${id} missing contract tokens: ${missingTokens.join(", ")}`); process.exit(1); }
// no runnable implementation code: no `import ... from` inside a fence that also has a function body with a runtime call.
// Allowed: type/interface/schema sketches. Reject top-level `import` statements in fenced blocks (ts code blocks).
const fences = [...text.matchAll(/```(\w+)?\n([\s\S]*?)```/g)];
const implFences = fences.filter(([, lang, body]) => ["ts", "typescript", "js", "javascript", "mjs"].includes((lang ?? "").toLowerCase()) && /^\s*import\s+(?!type)/m.test(body));
if (implFences.length) { console.error(`FAIL: ${id} contains runnable implementation code (${implFences.length} fence(s) with top-level import). Types/schemas only.`); process.exit(1); }
console.log(`doc ${id} verification passed (${(size / 1024).toFixed(1)}KB, ${MODULES[id].headers.length} sections, ${MODULES[id].tokens.length} contract tokens)`);
