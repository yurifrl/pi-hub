// cli/src/log_follow.test.ts — the tail follower (docs/03 §log: appended
// lines, survive truncate/rotate) over an injected FollowIo — no sleeps, no
// real fs timing (docs/01 §Testing).

import { describe, it, expect } from "bun:test";
import { makeLogFollower, nodeFollowIo, type FollowIo } from "./log_follow";

const io = (body: string, ino = 1, size = body.length): FollowIo => ({
  read: () => body,
  stat: () => ({ size, ino }),
});

describe("makeLogFollower", () => {
  it("first step returns the whole existing content (tail semantics)", () => {
    const body = `{"t":1,"sessionId":"s-a","kind":"tool_call","text":"one"}\n{"t":2,"sessionId":"s-a","kind":"agent_end","text":"two"}\n`;
    const f = makeLogFollower(io(body), "logs/s-a.jsonl");
    const step = f.step();
    expect(step.entries).toHaveLength(2);
    expect(step.entries[0]!.text).toBe("one");
    expect(step.rotated).toBe(false);
    expect(step.truncated).toBe(false);
    // second step: nothing new
    expect(f.step().entries).toHaveLength(0);
  });

  it("appended lines come back on later steps", () => {
    let body = `{"t":1,"sessionId":"s-a","kind":"tool_call","text":"one"}\n`;
    let size = body.length;
    const fake: FollowIo = { read: () => body, stat: () => ({ size, ino: 1 }) };
    const f = makeLogFollower(fake, "logs/s-a.jsonl");
    expect(f.step().entries).toHaveLength(1);
    body += `{"t":2,"sessionId":"s-a","kind":"assistant_message","text":"two"}\n`;
    size = body.length;
    const step = f.step();
    expect(step.entries).toHaveLength(1);
    expect(step.entries[0]!.text).toBe("two");
  });

  it("truncate resets and re-reads (size < offset)", () => {
    let body = `{"t":1,"sessionId":"s-a","kind":"tool_call","text":"one"}\n{"t":2,"sessionId":"s-a","kind":"agent_end","text":"two"}\n`;
    let size = body.length;
    const fake: FollowIo = { read: () => body, stat: () => ({ size, ino: 1 }) };
    const f = makeLogFollower(fake, "logs/s-a.jsonl");
    f.step();
    // truncated: fresh file with one line
    body = `{"t":9,"sessionId":"s-a","kind":"agent_end","text":"fresh"}\n`;
    size = body.length;
    const step = f.step();
    expect(step.truncated).toBe(true);
    expect(step.entries.map((e) => e.text)).toEqual(["fresh"]);
  });

  it("rotate (inode change) replays the fresh file", () => {
    let body = `{"t":1,"sessionId":"s-a","kind":"tool_call","text":"old"}\n`;
    const fake: FollowIo = { read: () => body, stat: () => ({ size: body.length, ino: 1 }) };
    const f = makeLogFollower(fake, "logs/s-a.jsonl");
    f.step();
    body = `{"t":2,"sessionId":"s-a","kind":"tool_call","text":"new"}\n`;
    fake.stat = () => ({ size: body.length, ino: 2 });
    const step = f.step();
    expect(step.rotated).toBe(true);
    expect(step.entries.map((e) => e.text)).toEqual(["new"]);
  });

  it("missing file → empty step, no throw (session open, no entries yet)", () => {
    const fake: FollowIo = { read: () => { throw new Error("enoent"); }, stat: () => null };
    const f = makeLogFollower(fake, "logs/ghost.jsonl");
    expect(f.step().entries).toEqual([]);
  });

  it("corrupt lines are skipped (docs/02 jsonl robustness)", () => {
    const body = `{"t":1,"sessionId":"s-a","kind":"tool_call","text":"ok"}\n{broken\n\n`;
    const f = makeLogFollower(io(body), "logs/s-a.jsonl");
    expect(f.step().entries.map((e) => e.text)).toEqual(["ok"]);
  });

  it("nodeFollowIo reads a real temp file (integration sanity)", async () => {
    const dir = await mkdtemp();
    const path = `${dir}/s-x.jsonl`;
    await Bun.write(path, `{"t":1,"sessionId":"s-x","kind":"tool_call","text":"real"}\n`);
    const f = makeLogFollower(nodeFollowIo(), path);
    expect(f.step().entries[0]!.text).toBe("real");
  });
});

const mkdtemp = async (): Promise<string> => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(tmpdir(), "hub-follow-"));
};
