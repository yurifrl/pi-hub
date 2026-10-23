// tests/bridge_plugin_contract.test.ts — the hermes plugin is the protocol's
// second client (Python, by runtime necessity: the hermes container cannot
// import @yurifrl/hub). Instead of code sharing, the plugin mirrors lib by
// layer (see its header map); these tests pin the mirrored vocabulary so the
// two sides cannot drift silently — drift here becomes live tool-call failures.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OP_NAMES } from "../lib/domain/command";

const repoRoot = join(import.meta.dir, "..");
const src = readFileSync(join(repoRoot, "bridge/hermes-hub-plugin/__init__.py"), "utf8");

/** Extract a module-level tuple from the plugin source. */
const pluginTuple = (name: string): string[] => {
  const m = src.match(new RegExp(`\\b${name} = \\(([^)]*)\\)`));
  if (!m) throw new Error(`${name} tuple not found in bridge/hermes-hub-plugin/__init__.py`);
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^".*"$/.test(s)) // quoted string tokens only — skips inline comments
    .map((s) => s.slice(1, -1));
};

const OPS = pluginTuple("OPS");
const ADVERTISED = pluginTuple("ADVERTISED_OPS");

test("plugin DOMAIN mirrors the canonical op registry exactly", () => {
  expect(OPS).toEqual([...OP_NAMES]);
});

test("tool schema advertises only ops the hub implements", () => {
  const known = new Set<string>(OP_NAMES);
  const unknown = ADVERTISED.filter((op) => !known.has(op));
  expect(unknown).toEqual([]);
});

test("tool schema keeps the ops its own description promises", () => {
  // The schema description names these explicitly; the advertised tuple must
  // not trim below that floor (description ↔ enum consistency).
  const floor = ["list", "sessions", "attention", "answer", "send", "assign", "spawn", "kill", "archive", "agent", "ping"];
  const advertised = new Set(ADVERTISED);
  const missing = floor.filter((op) => !advertised.has(op));
  expect(missing).toEqual([]);
});

test("plugin push kinds mirror hub AttentionKind minus idle (lib/domain/session.ts)", () => {
  // NOTIFY_KINDS is what the plugin delivers to a human: approval/question/
  // blocked need a person; "idle" is a hub-side bookkeeping state, not a
  // request. If the hub grows a kind, this test forces a conscious decision.
  const notify = pluginTuple("NOTIFY_KINDS");
  expect(notify).toEqual(["approval", "question", "blocked"]);
});
