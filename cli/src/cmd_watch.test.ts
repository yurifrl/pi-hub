// cli/src/cmd_watch.test.ts — `hub watch` through bin.run against a fake hub
// (capture-style per docs/01 §Testing: fake hub over a temp socket, temp
// dataRoot, piped/JSON stdout — never a real terminal, never sleeps):
// machine-mode snapshot shape, piped static frame + muted hint, offline
// degrade is not an exit, exit-code mapping.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntry, StatusFile } from "@yurifrl/hub";
import { run } from "./bin";
import { applyKey, applyEvent, initialWatchState } from "./screens/watch";
import { paneLines } from "./screens/watch";

let dir: string;

const sess = (over: Partial<StatusFile["sessions"][string]> = {}): StatusFile["sessions"][string] => ({
  status: "open",
  kind: "worker",
  cwd: "/tmp",
  title: "test session",
  model: "test-model",
  phase: "working",
  log: "logs/x.jsonl",
  toolCounts: {},
  turns: 0,
  startedAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  ...over,
});

let chunks: string[];
let errs: string[];
const origWrite = process.stdout.write.bind(process.stdout);
const origErrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-watch-test-"));
  chunks = [];
  errs = [];
  process.stdout.write = ((s: string) => {
    chunks.push(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    errs.push(s);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origWrite;
  process.stderr.write = origErrWrite;
  rmSync(dir, { recursive: true, force: true });
});

const writeData = (opts: { status?: StatusFile; logs?: Record<string, string[]> } = {}): void => {
  if (opts.status !== undefined) writeFileSync(join(dir, "status.json"), JSON.stringify(opts.status));
  if (opts.logs !== undefined) {
    mkdirSync(join(dir, "logs"), { recursive: true });
    for (const [id, lines] of Object.entries(opts.logs)) {
      writeFileSync(join(dir, "logs", `${id}.jsonl`), lines.join(""));
    }
  }
};

const entryLine = (t: number, sessionId: string, kind: string, text: string): string =>
  JSON.stringify({ t, sessionId, kind, text }) + "\n";

const capture = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  process.exitCode = undefined;
  const code = await run(argv);
  return { code, out: chunks.join(""), err: errs.join("") };
};

const configArg = (sock?: string): string[] => {
  const cfg = join(dir, "hub.config.json");
  writeFileSync(cfg, JSON.stringify(sock ? { sock, dataRoot: dir } : { dataRoot: dir }));
  return ["--config", cfg];
};

describe("watch — machine modes (docs/03 §hub watch Machine modes)", () => {
  it("--json prints a static snapshot (attention + sessions + last 50 entries), no alt-screen", async () => {
    const status: StatusFile = {
      version: 1,
      startedAt: new Date(0).toISOString(),
      pid: 1,
      nextAttentionId: 1,
      sessions: { "s-alpha12345678": sess() },
      attention: [{ id: "att-1", sessionId: "s-alpha12345678", kind: "approval", text: "approve?", createdAt: new Date(0).toISOString() }],
      archived: [],
    };
    writeData({
      status,
      logs: { "s-alpha12345678": [entryLine(1, "s-alpha12345678", "tool_call", "bun test")] },
    });
    const { code, out } = await capture([...configArg(), "--json", "watch"]);
    expect(code).toBe(0);
    const env = JSON.parse(out);
    expect(env.type).toBe("snapshot");
    expect(env.data.attention).toHaveLength(1);
    expect(env.data.attention[0].kind).toBe("approval");
    expect(env.data.entries).toHaveLength(1);
    expect(env.data.entries[0].text).toBe("bun test");
    expect(out).not.toContain("\x1b[?1049h"); // never alt-screen
  });

  it("--json with no hub data → empty snapshot, exit 0", async () => {
    const { code, out } = await capture([...configArg(), "--json", "watch"]);
    expect(code).toBe(0);
    const env = JSON.parse(out);
    expect(env.data.attention).toEqual([]);
    expect(env.data.entries).toEqual([]);
  });
});

describe("watch — piped stdout degrade (docs/03 §TTY degradation)", () => {
  it("one static frame: header, attention rail rows, log pane, muted hint; exit 0", async () => {
    const status: StatusFile = {
      version: 1,
      startedAt: new Date(0).toISOString(),
      pid: 1,
      nextAttentionId: 1,
      sessions: { "s-alpha12345678": sess() },
      attention: [{ id: "att-1", sessionId: "s-alpha12345678", kind: "approval", text: "approve deploy", createdAt: new Date(0).toISOString() }],
      archived: [],
    };
    writeData({
      status,
      logs: { "s-alpha12345678": [entryLine(1756562400000, "s-alpha12345678", "tool_call", "bun run build")] },
    });
    const { code, out } = await capture([...configArg(), "watch"]);
    expect(code).toBe(0);
    expect(out).toContain("NEEDS YOU");
    expect(out).toContain("approve deploy");
    expect(out).toContain("bun run build");
    expect(out).toContain("run hub in a terminal for live view");
    expect(out).not.toContain("\x1b[?1049h");
  });

  it("piped with hub unreachable → still renders from disk, exit 0 (offline is a state)", async () => {
    const status: StatusFile = {
      version: 1,
      startedAt: new Date(0).toISOString(),
      pid: 1,
      nextAttentionId: 1,
      sessions: { "s-betaaaaaaaaaa": sess() },
      attention: [],
      archived: [],
    };
    writeData({ status, logs: { "s-betaaaaaaaaaa": [entryLine(1, "s-betaaaaaaaaaa", "tool_call", "make")] } });
    const { code, out } = await capture([...configArg(), "watch"]); // no hub started
    expect(code).toBe(0);
    expect(out).toContain("make");
    expect(out).toContain("run hub in a terminal for live view");
  });
});

// ---- pure state-machine checks the host relies on (fake bus semantics) ----

describe("watch — fake bus event → pane paint (pure, no sockets)", () => {
  it("hub event frames appended via applyEvent land in paneLines", () => {
    let s = initialWatchState(null);
    s = applyEvent(s, { topic: "log", payload: { t: 1, sessionId: "s-a", kind: "tool_call", text: "event row" } });
    const lines = paneLines(s, () => 20);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.segs.map((x) => x[0]).join("")).toContain("event row");
  });

  it("q quits via applyKey → host exits 0", () => {
    const s = initialWatchState(null);
    expect(applyKey(s, { kind: "ctrl-c" }, 0).type).toBe("quit");
    expect(applyKey(s, { kind: "char", char: "q" }, 0).type).toBe("quit");
  });
});

// LogEntry unused import guard (shape checked in cmd_log.test.ts)
export type { LogEntry };
