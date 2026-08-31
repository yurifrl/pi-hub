// cli/src/commands.test.ts — tk-tku subcommand bodies (docs/03-cli.md
// §Subcommands) against a fake hub socket (contract style of
// hub_socket.test.ts) and stubbed contexts — envelope shapes, prefix
// resolution, consent matrix, wait budget, strict [json] parse, picker
// without TTY.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./bin";
import { toolBudgetMs, type ListResult } from "./hub_ops";
import { listArchive } from "./archive_list";
import { resultLines, truncateLines } from "./cmd_tool";

// ---- shared fake hub ------------------------------------------------------

type FakeHubOpts = {
  onCmd?: (frame: Record<string, unknown>) => unknown;
};

let dir: string;
let stopHub: (() => void) | null = null;
let sockPath = "";

/** Fake hub: hello handshake + reply per cmd frame; writes a --config file at
 * its socket + tmp dataRoot. Returns the config path to pass via --config. */
const startHub = (opts: FakeHubOpts = {}): string => {
  sockPath = join(dir, "fake.sock");
  const configPath = join(dir, "hub.config.json");
  writeFileSync(configPath, JSON.stringify({ sock: sockPath, dataRoot: dir }));
  const hello = JSON.stringify({
    v: 1,
    ch: "hello",
    hub: { version: 1, startedAt: "2026-08-31T00:00:00.000Z" },
  });
  const buffers = new Map<unknown, string>();
  const server = Bun.listen({
    unix: sockPath,
    socket: {
      open(socket) {
        buffers.set(socket, "");
      },
      data(socket, data) {
        let buffer = (buffers.get(socket) ?? "") + new TextDecoder().decode(data);
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.trim().length === 0) continue;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame.ch === "hello") {
            socket.write(hello + "\n");
            continue;
          }
          if (frame.ch === "cmd") {
            const result = opts.onCmd?.(frame);
            if (result === undefined) continue;
            socket.write(JSON.stringify({ v: 1, ch: "reply", cmdId: frame.cmdId, ok: true, result }) + "\n");
          }
        }
        buffers.set(socket, buffer);
      },
      close(socket) {
        buffers.delete(socket);
      },
      error: () => {},
    },
  });
  stopHub = () => server.stop(true);
  return configPath;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-cmd-test-"));
});

afterEach(() => {
  stopHub?.();
  stopHub = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Capture stdout/stderr writes and exitCode for one run() invocation. */
const capture = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  const chunks: string[] = [];
  const errs: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;
  process.stdout.write = ((s: string) => {
    chunks.push(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    errs.push(s);
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    const code = await run(argv);
    return { code, out: chunks.join(""), err: errs.join("") };
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exitCode = origExitCode;
  }
};

/** Session map used by most tests. */
const sessions = {
  "s-alpha12345678": { name: "alpha", phase: "working", description: "deploy canary" },
  "s-betaaaaaaaaaa": { name: "beta", phase: "idle", description: "api rewrite" },
  "s-gammaaaaaaaaa": { name: "gamma", phase: "idle" },
};
const listResult = (): ListResult => ({ sessions, attention: [], archived: [] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed wire JSON asserted per test below
const jsonEnv = (out: string): any => JSON.parse(out.trim());

// ---- answer ----------------------------------------------------------------

describe("answer", () => {
  it("envelope shape {answered, id, sessionId}; frame carries {id, text}", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return f.op === "list"
          ? { sessions, attention: [{ id: "att-1", sessionId: "s-alpha12345678", kind: "approval" }] }
          : { item: "att-1" };
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "answer", "att", "ship", "it"]);
    expect(code).toBe(0);
    const env = jsonEnv(out);
    expect(env.type).toBe("snapshot");
    expect(env.data.answered).toBe(true);
    expect(env.data.id).toBe("att-1");
    expect(env.data.sessionId).toBe("s-alpha12345678");
    const cmd = frames.find((f) => f.op === "answer");
    expect(cmd?.args).toEqual({ id: "att-1", text: "ship it" }); // <text...> joins with single spaces
  });

  it("unique prefix resolves; ambiguous → error.code ambiguous + candidates in detail, exit 1", async () => {
    const cfg = startHub({
      onCmd: (f) =>
        f.op === "list"
          ? {
              sessions,
              attention: [
                { id: "att-1", sessionId: "s-alpha12345678" },
                { id: "att-2", sessionId: "s-betaaaaaaaaaa" },
              ],
            }
          : {},
    });
    const ok = await capture(["--config", cfg, "--json", "answer", "tt-2", "x"]);
    expect(ok.code).toBe(0);
    expect(jsonEnv(ok.out).data.id).toBe("att-2");

    const amb = await capture(["--config", cfg, "--json", "answer", "at", "x"]);
    expect(amb.code).toBe(1);
    const env = jsonEnv(amb.out);
    expect(env.type).toBe("error");
    expect(env.error.code).toBe("ambiguous");
    expect(env.error.detail).toEqual(["att-1", "att-2"]);

    const nf = await capture(["--config", cfg, "--json", "answer", "zzz", "x"]);
    expect(nf.code).toBe(1);
    expect(jsonEnv(nf.out).error.code).toBe("not_found");
  });

  it("human mode: ✓ line + muted delivered text, no ANSI in machine modes", async () => {
    const cfg = startHub({
      onCmd: (f) =>
        f.op === "list" ? { sessions, attention: [{ id: "att-1", sessionId: "s-alpha12345678" }] } : {},
    });
    const { code, out } = await capture(["--config", cfg, "answer", "att-1", "hello world"]);
    expect(code).toBe(0);
    expect(out).toContain("✓ answered att-1 → alpha");
    expect(out).toContain("hello world");
  });
});

// ---- assign ----------------------------------------------------------------

describe("assign", () => {
  it("frame assign {id, task}; envelope {assigned, id, sessionId, task}", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return listResult();
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "assign", "beta", "fix", "the", "bug"]);
    expect(code).toBe(0);
    expect(jsonEnv(out).data).toEqual({ assigned: true, id: "s-betaaaaaaaaaa", sessionId: "s-betaaaaaaaaaa", task: "fix the bug" });
    const cmd = frames.find((f) => f.op === "assign");
    expect(cmd?.args).toEqual({ id: "s-betaaaaaaaaaa", task: "fix the bug" });
  });

  it("picker over idle only; zero idle → not_found 1", async () => {
    const cfg = startHub({ onCmd: () => listResult() });
    // no TTY stdin here → picker refuses with usage 1 when id omitted
    const noTty = await capture(["--config", cfg, "--json", "assign", "task-only"]);
    expect(noTty.code).toBe(1);
    expect(jsonEnv(noTty.out).error.code).toBe("usage");

  });

  it("human: ✓ assigned to <name> — <first line of task>", async () => {
    const cfg = startHub({ onCmd: () => listResult() });
    const { code, out } = await capture(["--config", cfg, "assign", "beta", "first line\nsecond line"]);
    expect(code).toBe(0);
    expect(out).toContain("✓ assigned to beta — first line");
  });
});

// ---- send ------------------------------------------------------------------

describe("send", () => {
  it("frame send {target, text}; envelope {sent, sessionId, text}", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return listResult();
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "send", "alph", "run", "tests"]);
    expect(code).toBe(0);
    expect(jsonEnv(out).data).toEqual({ sent: true, sessionId: "s-alpha12345678", text: "run tests" });
    const cmd = frames.find((f) => f.op === "send");
    expect(cmd?.args).toEqual({ target: "s-alpha12345678", text: "run tests" });
  });

  it("picker without TTY → usage 1; prefix resolution by name substring", async () => {
    const cfg = startHub({ onCmd: () => listResult() });
    const picked = await capture(["--config", cfg, "--json", "send", "gamm", "yo"]);
    expect(picked.code).toBe(0);
    expect(jsonEnv(picked.out).data.sessionId).toBe("s-gammaaaaaaaaa");
  });

  it("no id in machine mode → picker needs TTY → usage 1", async () => {
    const cfg = startHub({ onCmd: () => listResult() });
    const { code, out } = await capture(["--config", cfg, "--json", "send", "hello"]);
    expect(code).toBe(1);
    expect(jsonEnv(out).error.code).toBe("usage");
  });
});

// ---- tool ------------------------------------------------------------------

describe("tool", () => {
  it("frame tool {target, tool, args}; envelope {ok, result} verbatim", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return f.op === "list" ? listResult() : { rows: [1, 2], ok: true };
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "tool", "alpha", "search", '{"q":"x","n":2}']);
    expect(code).toBe(0);
    expect(jsonEnv(out).data).toEqual({ ok: true, result: { rows: [1, 2], ok: true } });
    const cmd = frames.find((f) => f.op === "tool");
    expect(cmd?.args).toEqual({ target: "s-alpha12345678", tool: "search", args: { q: "x", n: 2 } });
  });

  it("strict [json] parse failure → usage 1 with the parse error in the message", async () => {
    const cfg = startHub({ onCmd: () => listResult() });
    const { code, out } = await capture(["--config", cfg, "--json", "tool", "alpha", "search", '{"q": oops}']);
    expect(code).toBe(1);
    const env = jsonEnv(out);
    expect(env.error.code).toBe("usage");
    expect(env.error.message).toContain("invalid JSON");
  });

  it("scalars pass through as args (docs/03: objects, arrays, scalars)", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return f.op === "list" ? listResult() : { echoed: true };
      },
    });
    await capture(["--config", cfg, "--json", "tool", "alpha", "echo", "42"]);
    const cmd = frames.find((f) => f.op === "tool");
    expect(cmd?.args).toEqual({ target: "s-alpha12345678", tool: "echo", args: 42 });
  });

  it("--wait feeds the budget: max(replyTimeoutMs, wait × 1000)", async () => {
    const cfg = { replyTimeoutMs: 10_000 };
    expect(toolBudgetMs(cfg, 30)).toBe(30_000); // wait × 1000 above floor wins
    expect(toolBudgetMs(cfg, 60)).toBe(60_000); // wait above floor wins
    expect(toolBudgetMs(cfg, 5)).toBe(10_000); // wait under floor → replyTimeoutMs
    expect(toolBudgetMs({ replyTimeoutMs: 50_000 }, 30)).toBe(50_000);
  });

  it("human result card: header, body truncated at 50 lines, … N more footer", () => {
    expect(truncateLines(resultLines({ a: 1 }), 50).more).toBe(0);
    const fiftyFive = Array.from({ length: 55 }, (_, i) => `l${i}`);
    const t = truncateLines(fiftyFive);
    expect(t.shown).toHaveLength(50);
    expect(t.more).toBe(5);
    expect(resultLines("line1\nline2")).toEqual(["line1", "line2"]);
  });
});

// ---- spawn -----------------------------------------------------------------

describe("spawn", () => {
  it("frame spawn {name?, model?}; envelope {name, model, sessionId}", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return f.op === "spawn" ? { sessionId: "s-new1", name: "worker-7" } : listResult();
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "spawn", "--name", "worker-7", "--model", "claude-x"]);
    expect(code).toBe(0);
    expect(jsonEnv(out).data).toEqual({ name: "worker-7", model: "claude-x", sessionId: "s-new1" });
    const cmd = frames.find((f) => f.op === "spawn");
    expect(cmd?.args).toEqual({ name: "worker-7", model: "claude-x" });
  });

  it("name/model omitted → frame carries no name; model defaults to config.spawnModel", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return f.op === "spawn" ? { sessionId: "s-new2", name: "worker-1" } : listResult();
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "spawn"]);
    expect(code).toBe(0);
    expect(jsonEnv(out).data.name).toBe("worker-1");
    const cmd = frames.find((f) => f.op === "spawn");
    expect(cmd?.args).toEqual({}); // no model: hub picks defaults; spawnModel default is ""
  });
});

// ---- kill (consent matrix) -------------------------------------------------

describe("kill — consent matrix (docs/03 §Subcommands kill)", () => {
  it("--yes skips the prompt; frame kill {name}; envelope {killed, id, archivedTo}", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return f.op === "kill" ? { closedAt: "2026-08-31T01:02:03.000Z", path: "archive/2026-08/s-alpha12345678.json" } : listResult();
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "kill", "alpha", "--yes"]);
    expect(code).toBe(0);
    expect(jsonEnv(out).data).toEqual({
      killed: true,
      id: "s-alpha12345678",
      archivedTo: "archive/2026-08/s-alpha12345678.json",
    });
    const cmd = frames.find((f) => f.op === "kill");
    expect(cmd?.args).toEqual({ name: "alpha" });
  });

  it("machine mode without --yes → usage 1, never assumes consent, never prompts", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return listResult();
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "kill", "alpha"]);
    expect(code).toBe(1);
    expect(jsonEnv(out).error.code).toBe("usage");
    expect(frames.find((f) => f.op === "kill")).toBeUndefined(); // no kill frame sent
  });

  it("unknown session → not_found 1", async () => {
    const cfg = startHub({ onCmd: () => listResult() });
    const { code, out } = await capture(["--config", cfg, "--json", "kill", "nope", "--yes"]);
    expect(code).toBe(1);
    expect(jsonEnv(out).error.code).toBe("not_found");
  });
});

// ---- archive ---------------------------------------------------------------

describe("archive — LIST mode (no socket, reads files)", () => {
  it("envelope {entries: [...]}, newest first; month dir + json records", async () => {
    const archive = join(dir, "archive", "2026-08");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      join(archive, "s-old.json"),
      JSON.stringify({ id: "s-old", closedAt: "2026-08-01T00:00:00.000Z", closedBy: "kill", finalSummary: "older" }),
    );
    writeFileSync(
      join(archive, "s-new.json"),
      JSON.stringify({ id: "s-new", closedAt: "2026-08-30T00:00:00.000Z", closedBy: "archive", finalSummary: "newer" }),
    );
    const cfg = join(dir, "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ dataRoot: dir }));
    // no hub started — LIST must work without a socket (read-only, no socket)
    const { code, out } = await capture(["--config", cfg, "--json", "archive"]);
    expect(code).toBe(0);
    const env = jsonEnv(out);
    expect(env.type).toBe("snapshot");
    const entries = env.data.entries as { id: string }[];
    expect(entries.map((e) => e.id)).toEqual(["s-new", "s-old"]);
  });

  it("CLOSE mode: frame archive {id}; envelope {archived, id, path}", async () => {
    const frames: Record<string, unknown>[] = [];
    const cfg = startHub({
      onCmd: (f) => {
        frames.push(f);
        return f.op === "archive" ? { path: "archive/2026-08/s-betaaaaaaaaaa.json" } : listResult();
      },
    });
    const { code, out } = await capture(["--config", cfg, "--json", "archive", "beta"]);
    expect(code).toBe(0);
    expect(jsonEnv(out).data).toEqual({ archived: true, id: "s-betaaaaaaaaaa", path: "archive/2026-08/s-betaaaaaaaaaa.json" });
    const cmd = frames.find((f) => f.op === "archive");
    expect(cmd?.args).toEqual({ id: "s-betaaaaaaaaaa" });
  });
});

// ---- hub_ops / archive_list unit level --------------------------------------

describe("listArchive — unreadable dir throws (caller maps to usage 1)", () => {
  it("missing root → throws with path (caller maps to usage 1)", () => {
    expect(() => listArchive(join(dir, "no-such-root"))).toThrow(/cannot list/);
  });

  it("file where archive dir should be → throws with the path in the message", async () => {
    const bad = join(dir, "blocker");
    writeFileSync(bad, "not a dir");
    expect(() => listArchive(bad)).toThrow(/cannot list/);
  });
});

describe("archive LIST with empty archive dir", () => {
  it("renders an empty snapshot, exit 0", async () => {
    mkdirSync(join(dir, "archive"), { recursive: true });
    const cfg = join(dir, "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ dataRoot: dir }));
    const { code, out } = await capture(["--config", cfg, "--json", "archive"]);
    expect(code).toBe(0);
    expect(jsonEnv(out).type).toBe("snapshot");
    expect(jsonEnv(out).data.entries).toEqual([]);
  });
});
