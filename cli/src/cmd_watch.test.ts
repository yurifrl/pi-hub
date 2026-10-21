// cli/src/cmd_watch.test.ts — `hub watch` through bin.run against temp data
// (capture-style per docs/01 §Testing: temp dataRoot, piped/JSON stdout —
// never a real terminal, never sleeps): machine-mode snapshot shape, piped
// static frame + muted hint, offline degrade is not an exit.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusFile } from "@yurifrl/hub";
import { run } from "./bin";

let dir: string;

const sess = (over: Partial<StatusFile["sessions"][string]> = {}): StatusFile["sessions"][string] => ({
  status: "open",
  kind: "worker",
  cwd: "/tmp/proj",
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

/** disk-vocabulary line (docs/02 §logs): ISO `t`, kind prompt|tool|message|… */
const diskLine = (iso: string, sessionId: string, kind: string, text: string): string =>
  JSON.stringify({ t: iso, sessionId, kind, text }) + "\n";

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

const statusOf = (over: Partial<StatusFile> = {}): StatusFile => ({
  version: 1,
  startedAt: new Date(0).toISOString(),
  pid: 1,
  nextAttentionId: 1,
  sessions: { "s-alpha12345678": sess() },
  attention: [],
  archived: [],
  ...over,
});

describe("watch — machine modes (docs/03 §hub watch Machine modes)", () => {
  it("--json prints a static snapshot (attention + sessions + last 50 entries), no alt-screen", async () => {
    writeData({
      status: statusOf({
        attention: [{ id: "att-1", sessionId: "s-alpha12345678", kind: "approval", text: "approve?", createdAt: new Date(0).toISOString() }],
      }),
      logs: { "s-alpha12345678": [diskLine("2026-08-30T18:00:00.000Z", "s-alpha12345678", "tool", "bun test")] },
    });
    const { code, out } = await capture([...configArg(), "--json", "watch"]);
    expect(code).toBe(0);
    const env = JSON.parse(out);
    expect(env.type).toBe("snapshot");
    expect(env.data.attention).toHaveLength(1);
    expect(env.data.attention[0].kind).toBe("approval");
    expect(env.data.entries).toHaveLength(1);
    expect(env.data.entries[0].text).toBe("bun test");
    expect(env.data.entries[0].kind).toBe("tool_call"); // normalized at the file boundary
    expect(typeof env.data.entries[0].t).toBe("number");
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
  it("one static frame: sessions rail, selected chat, open question, muted hint; exit 0", async () => {
    writeData({
      status: statusOf({
        attention: [{ id: "att-1", sessionId: "s-alpha12345678", kind: "approval", text: "approve deploy", createdAt: new Date(0).toISOString() }],
      }),
      logs: {
        "s-alpha12345678": [
          diskLine("2026-08-30T18:00:00.000Z", "s-alpha12345678", "prompt", "deploy the canary"),
          diskLine("2026-08-30T18:00:01.000Z", "s-alpha12345678", "tool", "bun run build"),
        ],
      },
    });
    const { code, out } = await capture([...configArg(), "watch"]);
    expect(code).toBe(0);
    expect(out).toContain("1 need you");
    expect(out).toContain("proj"); // rail label = cwd basename
    expect(out).toContain("deploy the canary");
    expect(out).toContain("bun run build");
    expect(out).toContain("approve deploy");
    expect(out).toContain("run hub in a terminal for live view");
    expect(out).not.toContain("\x1b[?1049h");
  });

  it("piped with hub unreachable → still renders from disk, exit 0 (offline is a state)", async () => {
    writeData({
      status: statusOf({ sessions: { "s-betaaaaaaaaaa": sess() } }),
      logs: { "s-betaaaaaaaaaa": [diskLine("2026-08-30T18:00:00.000Z", "s-betaaaaaaaaaa", "tool", "make")] },
    });
    const { code, out } = await capture([...configArg(), "watch"]); // no hub started
    expect(code).toBe(0);
    expect(out).toContain("make");
    expect(out).toContain("run hub in a terminal for live view");
  });
});
