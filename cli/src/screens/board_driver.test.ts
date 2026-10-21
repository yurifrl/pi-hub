// cli/src/screens/board_driver.test.ts — board driver end-to-end over a fake
// hub socket (docs/03 §hub (bare)): inline answer/assign/dismiss produce the
// exact cmd frames (fake command surface contract), piped stdout renders one
// static frame + muted hint with exit 0, machine modes print the snapshot
// envelope, key-driven navigation runs through the real readKeys stream.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runBoard, boardMachineData } from "./board";
import { initialBoardState, type BoardSnapshot, type BoardState } from "./board_state";
import type { AttentionItem, SessionRecord } from "@yurifrl/hub";
import type { CommandContext } from "../commands";
import type { HubCliConfig } from "../config";

// ---- fixtures ---------------------------------------------------------------

const session = (over: Record<string, unknown> = {}): SessionRecord =>
  ({
    status: "open",
    kind: "worker",
    cwd: "/tmp",
    title: "default title",
    model: "m",
    phase: "working",
    log: "logs/x.jsonl",
    toolCounts: {},
    turns: 0,
    startedAt: "2026-08-31T10:00:00.000Z",
    lastActivity: "2026-08-31T11:58:00.000Z",
    ...over,
  }) as SessionRecord;

const sessions: Record<string, SessionRecord> = {
  "s-alpha12345678": session({ name: "alpha", description: "editing deploy/canary.sh" }),
  "s-gammaaaaaaaaa": session({ name: "gamma", phase: "idle", title: "api idle" }),
};

const attention: AttentionItem[] = [
  { id: "att-1", sessionId: "s-alpha12345678", kind: "approval", text: "approve deploy canary 2/3?", createdAt: "2026-08-31T11:50:00.000Z" },
];

const listReply = (): BoardSnapshot => ({
  sessions,
  attention,
  hub: { digest: "tilt needs approval", agentSession: "s-agent000000" },
});

// ---- stub command surface (fake cmd — the acceptance contract) ----------------

type RecordedFrame = { op: string; args: Record<string, unknown> };

const stubCtx = (opts: { stdoutTty?: boolean; stdinTty?: boolean; listResult?: BoardSnapshot } = {}) => {
  const frames: RecordedFrame[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  (stdout as unknown as { isTTY?: boolean }).isTTY = opts.stdoutTty ?? false;
  (stdout as unknown as { columns?: number }).columns = 0;
  const stdin = new PassThrough();
  (stdin as unknown as { isTTY?: boolean }).isTTY = opts.stdinTty ?? false;
  const ctx: CommandContext = {
    config: {
      sock: "/tmp/none.sock",
      dataRoot: "/tmp/none",
      replyTimeoutMs: 1000,
      webPort: 4820,
      spawnModel: "",
      ompBin: "omp",
      color: false,
    } as HubCliConfig,
    policy: { format: "human", color: false },
    files: {
      logEntries: () => [],
      summaryLines: () => [],
      status: () => null,
      recentLogIds: () => [],
    },
    io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
    cmd: async (op, args) => {
      frames.push({ op, args: args as Record<string, unknown> });
      if (op === "list" || op === "attention") return { result: opts.listResult ?? listReply() };
      return { result: { ok: true } };
    },
  };
  return { ctx, frames, stdout, stdin };
};

const drain = (stream: PassThrough): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.end();
    // small delay lets pending writes flush
    setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), 20);
  });

// ---- machine + piped degrades (no alt-screen) ---------------------------------

describe("runBoard — machine modes (docs/03 §Machine modes)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-board-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--json: one snapshot envelope {orientation, attention, running, idle}, exit 0, no alt-screen", async () => {
    const { ctx, frames, stdout } = stubCtx();
    (ctx.policy as { format: string }).format = "json";
    const code = await runBoard(ctx);
    expect(code).toBe(0);
    expect(frames.every((f) => f.op === "list")).toBe(true); // no mutation frames
    const out = await drain(stdout);
    const env = JSON.parse(out);
    expect(env.type).toBe("snapshot");
    expect(env.data.orientation).toBe("tilt needs approval");
    expect(env.data.attention).toHaveLength(1);
    expect(env.data.running).toHaveLength(1);
    expect(env.data.idle).toHaveLength(1);
    expect(out).not.toContain("\x1b[?1049h"); // never alt-screen
  });

  it("--ndjson: same data on one line", async () => {
    const { ctx, stdout } = stubCtx();
    (ctx.policy as { format: string }).format = "ndjson";
    await runBoard(ctx);
    const out = await drain(stdout);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe("snapshot");
  });
});

describe("runBoard — piped stdout degrade (docs/03 §TTY degradation)", () => {
  it("one static human frame + muted hint, exit 0", async () => {
    const { ctx, stdout } = stubCtx();
    const code = await runBoard(ctx);
    expect(code).toBe(0);
    const out = await drain(stdout);
    expect(out).toContain("hub · 2 sessions · 1 agent · tilt needs approval");
    expect(out).toContain("⚠ NEEDS YOU");
    expect(out).toContain("approval");
    expect(out).toContain("⏳ RUNNING");
    expect(out).toContain("💤 IDLE");
    expect(out).toContain("run hub in a terminal for live view");
    expect(out).not.toContain("\x1b[?1049h"); // no alt-screen
  });
});

// ---- interactive board over a fake TTY ------------------------------------------

/** Feed keys as raw bytes into the fake TTY stdin and run the board until quit. */
const driveKeys = async (keys: string[], listResult?: BoardSnapshot): Promise<{ code: number; out: string; frames: RecordedFrame[] }> => {
  const { ctx, frames, stdout, stdin } = stubCtx({ stdoutTty: true, stdinTty: true, ...(listResult !== undefined ? { listResult } : {}) });
  const setRawMode = (on: boolean): void => {
    (stdin as unknown as { setRawModeInvocations?: boolean[] }).setRawModeInvocations = [
      ...(((stdin as unknown as { setRawModeInvocations?: boolean[] }).setRawModeInvocations) ?? []),
      on,
    ];
  };
  (stdin as unknown as { setRawMode?: (on: boolean) => void }).setRawMode = setRawMode;
  const runPromise = runBoard(ctx).then((code) => ({ code, out: "", frames }));
  // push key bytes after the board boots
  await new Promise((r) => setTimeout(r, 30));
  for (const k of keys) stdin.write(k);
  await new Promise((r) => setTimeout(r, 30));
  stdin.end();
  const result = await runPromise;
  const out = await drain(stdout);
  return { ...result, out };
};

describe("runBoard — interactive key matrix (docs/03 §Keys, §Refresh)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-board-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("typing + enter on an attention item issues cmd answer {id, text}", async () => {
    const { code, frames } = await driveKeys(["y", "e", "s", "\r"]);
    expect(code).toBe(0);
    const answer = frames.find((f) => f.op === "answer");
    expect(answer).toBeDefined();
    expect(answer!.args).toEqual({ id: "att-1", text: "yes" });
  });

  it("typing + enter on an idle row issues cmd assign {id, task}", async () => {
    // fixture: 1 attention item → focus walks att-0, att-0(wrap from down), idle row
    const { frames } = await driveKeys(["\x1b[B", "\x1b[B", "\x1b[B", "r", "u", "n", "\r"]); // down down down → idle row
    const assign = frames.find((f) => f.op === "assign");
    expect(assign).toBeDefined();
    expect(assign!.args).toEqual({ id: "s-gammaaaaaaaaa", task: "run" });
  });

  it("d dismisses via cmd attention {action:'dismiss', id} (docs/03 §Decision)", async () => {
    const { frames } = await driveKeys(["d"]);
    const dismiss = frames.find((f) => f.op === "attention");
    expect(dismiss).toBeDefined();
    expect(dismiss!.args).toEqual({ action: "dismiss", id: "att-1" });
  });

  it("arrows move focus; typing appends; esc blurs (frame-level re-render happens)", async () => {
    const { out } = await driveKeys(["\x1b[B", "\x1b[B", "r", "\x1b"]);
    expect(out).toContain("▎"); // rows painted with hue bars
    expect(out).toContain("NEEDS YOU");
  });

  it("q quits with exit 0 and restores the terminal", async () => {
    const { code, out } = await driveKeys(["q"]);
    expect(code).toBe(0);
    expect(out).toContain("\x1b[?1049l"); // rmcup on the exit path
    expect(out).toContain("\x1b[?25h"); // cursor shown
  });

  it("ctrl-c quits with exit 0 (key, not signal)", async () => {
    const { code } = await driveKeys(["\x03"]);
    expect(code).toBe(0);
  });
});

// ---- pure boardMachineData expectations ------------------------------------------

describe("boardMachineData", () => {
  it("running entries carry name/phase/description", () => {
    const state: BoardState = initialBoardState(listReply());
    const data = boardMachineData(state);
    const running = data.running as Array<Record<string, unknown>>;
    expect(running[0]).toMatchObject({ id: "s-alpha12345678", name: "alpha", phase: "working", description: "editing deploy/canary.sh" });
    const idle = data.idle as Array<Record<string, unknown>>;
    expect(idle[0]).toMatchObject({ id: "s-gammaaaaaaaaa", name: "gamma", phase: "idle" });
  });
});
