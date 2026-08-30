#!/usr/bin/env node
// G7: spec.html renders the full implementation spec — all six doc sections
// present (inline), backing docs exist, tag balance ok, attention-first framing.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const file = join(root, "spec.html");
if (!existsSync(file)) { console.error("FAIL: spec.html missing"); process.exit(1); }
const size = statSync(file).size;
if (size < 40 * 1024) {
  console.error(`FAIL: spec.html too small (${(size / 1024).toFixed(0)}KB < 40KB) — it must embed the six docs, not link-drop`);
  process.exit(1);
}
const html = readFileSync(file, "utf8");

// backing docs must exist for every embedded section
const docIds = ["01-architecture", "02-data-contracts", "03-cli", "04-web", "05-omp-plugin", "06-agents-and-skills"];
const missingDocs = docIds.filter((d) => !existsSync(join(root, "docs", `${d}.md`)));
if (missingDocs.length) { console.error(`FAIL: spec.html references missing backing docs: ${missingDocs.join(", ")}`); process.exit(1); }

// every doc id must appear in the html (embedded section anchors)
const missingSections = docIds.filter((id) => !html.includes(id));
if (missingSections.length) { console.error(`FAIL: spec.html missing sections: ${missingSections.join(", ")}`); process.exit(1); }

// key spec concepts
const required = ["attention", "DRY", "hexagonal", "status.json", "hub.sock", "hub_send_message", "hub_answer", "hub_assign", "watcher", "pending", "SSE", "exit code"];
const missTok = required.filter((t) => !html.includes(t));
if (missTok.length) { console.error(`FAIL: spec.html missing concept tokens: ${missTok.join(", ")}`); process.exit(1); }

// tag balance
const divs = (html.match(/<div/g) ?? []).length - (html.match(/<\/div>/g) ?? []).length;
const secs = (html.match(/<section/g) ?? []).length - (html.match(/<\/section>/g) ?? []).length;
if (divs !== 0 || secs !== 0) { console.error(`FAIL: spec.html tag balance divs=${divs} sections=${secs}`); process.exit(1); }
console.log(`spec html verification passed (${(size / 1024).toFixed(0)}KB, ${docIds.length} doc sections, tags balanced)`);
