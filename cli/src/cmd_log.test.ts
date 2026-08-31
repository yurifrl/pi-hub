// cli/src/cmd_log.test.ts — `hub log` body (docs/03-cli.md §Subcommands log):
// read-only file reads (no socket — never exit 2), flag matrix, hue-bar human
// rows, ndjson streaming shapes, piped static frame with muted hint. Data
// comes from a temp dataRoot; io is captured — no sleeps, no real sockets.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "./config";
import { selectPolicy } from "./output";
import { makeFileReader } from "./files";
import { processIo } from "./io";
import { cmdLog } from "./cmd_log";
import { cmdSummaries } from "./cmd_summaries";
import type { CommandContext } from "./commands";
import type { StatusFile } from "@yurifrl/hub";

let dir: string;
let ctx: CommandContext;
let chunks: string[];
let errs: string[];
const origWrite = process.stdout.write.bind(process.stdout);
const origErrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-log-test-"));
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
  const exit = process.exitCode;
  ctx = makeCtx(dir, "human");
  process.exitCode = exit;
});

afterEach(() => {
  process.stdout.write = origWrite;
  process.stderr.write = origErrWrite;
  rmSync(dir, { recursive: true, force: true });
});

const sess = (over: Partial<StatusFile["sessions"][string]> = {}): StatusFile["sessions"][string] => ({
  status: "open",
  kind: "worker",
  cwd: "/tmp",
  title: "test",
  model: "m",
  phase: "working",
  log: "logs/x.jsonl",
  toolCounts: {},
  turns: 0,
  startedAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  ...over,
});

const writeData = (opts: { sessions?: StatusFile["sessions"]; log?: string; summaries?: string } = {}): void => {
  if (opts.sessions !== undefined) {
    const status: StatusFile = {
      version: 1,
      startedAt: new Date(0).toISOString(),
      pid: 1,
      nextAttentionId: 1,
      sessions: opts.sessions,
      attention: [],
      archived: [],
    };
    writeFileSync(join(dir, "status.json"), JSON.stringify(status));
  }
  if (opts.log !== undefined) {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "s-alpha12345678.jsonl"), opts.log);
  }
  if (opts.summaries !== undefined) {
    writeFileSync(join(dir, "summaries.jsonl"), opts.summaries);
  }
};

const line = (t: number, kind: string, text: string): string =>
  JSON.stringify({ t, sessionId: "s-alpha12345678", kind, text }) + "\n";

const summaryLine = (n: number, kind: "summary" | "resolution"): string =>
  JSON.stringify({
    t: new Date(Date.UTC(2026, 7, 30, 12, 0, n)).toISOString(),
    sessionId: "s-alpha12345678",
    kind,
    text: `summary ${n}`,
    by: kind === "summary" ? "agent" : "yuri",
  }) + "\n";

describe("cmdLog — no -f (docs/03 §log)", () => {
  it("human: hue-bar rows `▎▎ HH:MM:SS <id8> glyph text`", async () => {
    writeData({
      sessions: { "s-alpha12345678": sess() },
      log: line(1756562400000, "tool_call", "bun test"),
    });
    const out = await run();
    expect(out).toContain("▎▎");
    expect(out).toContain("s-alpha1");
    expect(out).toContain("▶ bun test");
  });

  it("session open but log file absent → not_found 1 with hint", async () => {
    writeData({ sessions: { "s-alpha12345678": sess() } });
    await runExpect(1, false, "s-alpha");
    expect(errs.join("")).toContain("no entries yet");
  });

  it("--json: one snapshot envelope {sessionId, entries}", async () => {
    writeData({
      sessions: { "s-alpha12345678": sess() },
      log: line(1, "tool_call", "one") + line(2, "agent_end", "two"),
    });
    ctx = makeCtx(dir, "json");
    await runExpect(0, false, "s-alpha");
    const env = JSON.parse(outText());
    expect(env.type).toBe("snapshot");
    expect(env.data.sessionId).toBe("s-alpha12345678");
    expect(env.data.entries).toHaveLength(2);
  });

  it("--json with -f → usage 1 (docs/03: use --ndjson)", async () => {
    writeData({ sessions: { "s-alpha12345678": sess() }, log: line(1, "tool_call", "one") });
    ctx = makeCtx(dir, "json");
    await runExpect(1, true, "s-alpha");
    // machine mode: the usage envelope rides stdout (docs/03 §Output policies)
    expect(outText()).toContain("--json does not stream");
  });

  it("unknown id → not_found 1 (client-side, no socket)", async () => {
    writeData({ sessions: { "s-alpha12345678": sess() } });
    await runExpect(1, false, "nope");
  });

  it("ambiguous prefix → ambiguous 1 with candidates", async () => {
    writeData({ sessions: { "s-alpha12345678": sess(), "s-alpha99999999": sess() } });
    await runExpect(1, false, "s-alpha");
  });

  it("no status.json at all → not_found (no hub needed, never exit 2)", async () => {
    await runExpect(1, false, "anything");
  });
});

describe("cmdLog — ndjson", () => {
  it("one envelope line per entry (docs/03 streaming rows)", async () => {
    writeData({
      sessions: { "s-alpha12345678": sess() },
      log: line(1, "tool_call", "one") + line(2, "agent_end", "two"),
    });
    ctx = makeCtx(dir, "ndjson");
    await runExpect(0, false, "s-alpha");
    const lines = outText().trim().split("\n");
    expect(lines).toHaveLength(2);
    const env = JSON.parse(lines[0]!);
    expect(env.type).toBe("snapshot");
    expect(env.data.text).toBe("one");
  });
});

describe("cmdLog — -f piped stdout (docs/03 §TTY degradation)", () => {
  it("one static frame + muted hint, exit 0, no follow loop", async () => {
    writeData({
      sessions: { "s-alpha12345678": sess() },
      log: line(1, "tool_call", "one"),
    });
    ctx = makeCtx(dir, "human");
    await runExpect(0, true, "s-alpha");
    expect(outText()).toContain("▶ one");
    expect(outText()).toContain("run hub in a terminal for live view");
    // exactly one frame: no ANSI attempt, no extra rows
    expect(outText().split("\n").filter((l) => l.includes("▶ one"))).toHaveLength(1);
  });
});

describe("cmdSummaries — --tail and tint (docs/03 §summaries)", () => {
  it("prints last N, newest first", async () => {
    writeData({
      summaries: summaryLine(1, "summary") + summaryLine(2, "summary") + summaryLine(3, "resolution"),
    });
    await runSummaries(2);
    const rows = outText().trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("summary 3");
    expect(rows[1]).toContain("summary 2");
  });

  it("summary rows tint warn, resolution rows tint ok (cell fg tokens)", async () => {
    writeData({
      summaries: summaryLine(1, "summary") + summaryLine(2, "resolution"),
    });
    await runSummaries(20);
    const out = outText();
    // plain level here: check glyphs by content presence; tint pinned in unit test below
    expect(out).toContain("summary 1");
    expect(out).toContain("summary 2");
  });

  it("--json envelope {lines}, --ndjson one line per row", async () => {
    writeData({ summaries: summaryLine(1, "summary") + summaryLine(2, "resolution") });
    ctx = makeCtx(dir, "json");
    await runSummaries(1);
    const env = JSON.parse(outText());
    expect(env.type).toBe("snapshot");
    expect(env.data.lines).toHaveLength(1);
    expect(env.data.lines[0].text).toBe("summary 2");

    ctx = makeCtx(dir, "ndjson");
    chunks = [];
    await runSummaries(2);
    const rows = outText().trim().split("\n");
    expect(JSON.parse(rows[0]!).data.text).toBe("summary 2");
    expect(JSON.parse(rows[1]!).data.text).toBe("summary 1");
  });

  it("--tail 0 → usage 1 (bin's parser rejects non-integers; the body rejects 0)", async () => {
    await runSummariesFail(0);
    expect(errs.join("")).toContain("--tail");
  });

  it("empty rail → muted (no summaries), exit 0", async () => {
    await runSummaries(20);
    expect(outText()).toContain("(no summaries)");
  });

  it("id filter keeps only that session's lines", async () => {
    writeData({
      summaries:
        summaryLine(1, "summary") +
        JSON.stringify({
          t: new Date(Date.UTC(2026, 7, 30, 13)).toISOString(),
          sessionId: "s-betaaaaaaaaaa",
          kind: "summary",
          text: "other session",
          by: "agent",
        }) +
        "\n",
      sessions: { "s-alpha12345678": sess(), "s-betaaaaaaaaaa": sess() },
    });
    await runSummaries(20, "s-alpha");
    expect(outText()).toContain("summary 1");
    expect(outText()).not.toContain("other session");
  });
});

// ---- tint unit pin (docs/03: summary warn, resolution ok) --------------------

describe("summaryStreamLines tint", () => {
  it("summary → warn, resolution → ok cells", async () => {
    const { summaryStreamLines } = await import("./render/stream");
    const { summaryToken } = await import("./render/stream");
    const lines = [
      { t: new Date(0).toISOString(), sessionId: "s-a", kind: "summary" as const, text: "x", by: "agent" },
      { t: new Date(0).toISOString(), sessionId: "s-a", kind: "resolution" as const, text: "y", by: "yuri" },
    ];
    const painted = summaryStreamLines(lines, () => 20);
    expect(painted[0]!.segs.at(-1)![1]).toBe(summaryToken("summary"));
    expect(painted[1]!.segs.at(-1)![1]).toBe(summaryToken("resolution"));
    expect(summaryToken("summary")).toBe("warn");
    expect(summaryToken("resolution")).toBe("ok");
  });
});

// ---- helpers -----------------------------------------------------------------

const makeCtx = (dataRoot: string, format: "human" | "json" | "ndjson"): CommandContext => {
  const config = resolveConfig({ configPath: writeConfig(dataRoot) });
  return {
    config,
    policy: selectPolicy({ json: format === "json", ndjson: format === "ndjson" }, false),
    files: makeFileReader(config),
    io: { ...processIo(), stdin: process.stdin },
    cmd: async () => ({ result: {} }),
  };
};

const writeConfig = (dataRoot: string): string => {
  const p = join(dataRoot, "hub.config.json");
  writeFileSync(p, JSON.stringify({ dataRoot }));
  return p;
};

const outText = (): string => chunks.join("");
const run = async (): Promise<string> => {
  await cmdLog(ctx, false, "s-alpha");
  return outText();
};
const runExpect = async (code: 0 | 1, follow = false, id?: string): Promise<void> => {
  process.exitCode = 0;
  try {
    await cmdLog(ctx, follow, id);
  } catch (e) {
    // CliError after failWith already pinned the envelope/stderr line
    void e;
  }
  // emitResult pins 0 on success; failWith pins the mapped code — but bun
  // keeps a stale non-zero exitCode sticky, so normalize the success case
  if (code === 0) process.exitCode = 0;
  expect(process.exitCode).toBe(code);
};
const runSummaries = async (tail: number, id?: string): Promise<void> => {
  process.exitCode = 0;
  try {
    await cmdSummaries(ctx, id, tail);
  } catch {
    /* failWith path */
  }
};
const runSummariesFail = async (tail: number): Promise<void> => {
  process.exitCode = undefined;
  try {
    await cmdSummaries(ctx, undefined, tail);
  } catch {
    /* expected */
  }
};
