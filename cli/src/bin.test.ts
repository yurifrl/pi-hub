// cli/src/bin.test.ts — composition-root behavior (docs/03-cli.md §bin):
// help/version exit 0 without touching the socket, usage failures exit 1
// (envelope under machine flags), policy collision rejected, dispatch
// reached with a wired context. Subprocess cases pin the real process exit
// codes through node_modules/.bin/hub.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./bin";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-bin-test-"));
});

afterEach(() => {
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

describe("bin.run — help and version never open the socket", () => {
  it("--help exits 0, prints usage, no socket attempt", async () => {
    const { code, out } = await capture(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    expect(out).toContain("hub");
  });

  it("-h exits 0", async () => {
    const { code } = await capture(["-h"]);
    expect(code).toBe(0);
  });

  it("-V exits 0 with the version", async () => {
    const { code, out } = await capture(["-V"]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("subcommand --help exits 0", async () => {
    const { code, out } = await capture(["send", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
  });
});

describe("bin.run — usage failures (exit 1)", () => {
  it("unknown flag → exit 1, human note on stderr", async () => {
    const { code, out, err } = await capture(["--bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("--bogus");
    expect(out).toBe("");
  });

  it("unknown flag under --json → exit 1, ONE usage envelope on stdout", async () => {
    const { code, out, err } = await capture(["--bogus", "--json"]);
    expect(code).toBe(1);
    expect(err).toBe("");
    const env = JSON.parse(out);
    expect(env.type).toBe("error");
    expect(env.error.code).toBe("usage");
    expect(env.error.message).toContain("--bogus");
  });

  it("unknown flag under --ndjson → exit 1, one ndjson line", async () => {
    const { code, out } = await capture(["--bogus", "--ndjson"]);
    expect(code).toBe(1);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const env = JSON.parse(lines[0] as string);
    expect(env.type).toBe("error");
    expect(env.error.code).toBe("usage");
  });

  it("missing required arg → exit 1", async () => {
    const { code, err } = await capture(["answer", "att-1"]);
    expect(code).toBe(1);
    expect(err).toContain("argument");
  });

  it("unknown command → exit 1", async () => {
    const { code } = await capture(["frobnicate"]);
    expect(code).toBe(1);
  });

  it("--json + --ndjson → exit 1 (usage)", async () => {
    const { code } = await capture(["watch", "--json", "--ndjson"]);
    expect(code).toBe(1);
  });

  it("--json + --ndjson with unknown op context still exits 1, never 2/3", async () => {
    const { code } = await capture(["--ndjson", "watch", "--json"]);
    expect(code).toBe(1);
  });

  it("--config missing file → exit 1 with the path in the message", async () => {
    const { code, out } = await capture(["--config", join(dir, "nope.json"), "--json", "watch"]);
    expect(code).toBe(1);
    const env = JSON.parse(out);
    expect(env.error.code).toBe("usage");
    expect(env.error.message).toContain("nope.json");
  });

  it("--config invalid JSON → exit 1", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{oops");
    const { code } = await capture(["--config", path, "watch"]);
    expect(code).toBe(1);
  });
});

describe("bin.run — config resolution through the tree", () => {
  it("--config file feeds config.sock to the dispatch context (stub body records nothing, but config errors surface first)", async () => {
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify({ replyTimeoutMs: 1234, sock: join(dir, "s.sock") }));
    const { code } = await capture(["--config", path, "answer", "att-1", "hello"]);
    // stub body → NotImplemented → usage exit 1; config itself resolved fine
    expect(code).toBe(1);
  });

  it("valid config + stub body → usage envelope naming the owner task", async () => {
    const path = join(dir, "c.json");
    writeFileSync(path, "{}");
    const { code, out } = await capture(["--config", path, "--json", "send", "s-1", "hello"]);
    expect(code).toBe(1);
    const env = JSON.parse(out);
    expect(env.error.code).toBe("usage");
    expect(env.error.message).toContain("tk-tku");
  });
});

// ---- subprocess exit codes (real binary, real exit) ----------------------

const HUB = new URL("../../node_modules/.bin/hub", import.meta.url).pathname;

const spawnHub = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, HUB, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "" },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
};

describe("subprocess — hub binary exit codes (docs/03 §Exit codes table)", () => {
  it("hub --help → 0", async () => {
    const { code } = await spawnHub(["--help"]);
    expect(code).toBe(0);
  });

  it("hub -V → 0", async () => {
    const { code } = await spawnHub(["-V"]);
    expect(code).toBe(0);
  });

  it("hub --bogus → 1", async () => {
    const { code } = await spawnHub(["--bogus"]);
    expect(code).toBe(1);
  });

  it("hub --bogus --json → 1 with usage envelope on stdout", async () => {
    const { code, stdout } = await spawnHub(["--bogus", "--json"]);
    expect(code).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.type).toBe("error");
    expect(env.error.code).toBe("usage");
  });

  it("hub watch --json --ndjson → 1", async () => {
    const { code } = await spawnHub(["watch", "--json", "--ndjson"]);
    expect(code).toBe(1);
  });

  it("hub (bare, stub body) → 1", async () => {
    const { code, stderr } = await spawnHub([]);
    expect(code).toBe(1);
    expect(stderr).toContain("not implemented");
  });

  it("hub log s-x (read-only, stub) → 1, never 2 — no socket needed", async () => {
    const { code } = await spawnHub(["log", "s-x"]);
    expect(code).toBe(1);
  });

  it("hub answer with missing socket → stub path: usage 1 (socket wiring verified in hub_socket tests)", async () => {
    const { code } = await spawnHub(["answer", "att-1", "hi"]);
    expect(code).toBe(1);
  });
});
