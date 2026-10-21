// lib/domain/command.test.ts — pure unit: Result helpers, op registry, reply shape.
import { describe, it, expect } from "bun:test";
import { hubError, OP_NAMES, type CommandRequest, type CommandReply, type CommandSurface } from "./command";

describe("hubError", () => {
  it("transient codes are retryable", () => {
    expect(hubError("unavailable-hub", "hub not running").retryable).toBe(true);
    expect(hubError("timeout", "no reply in 30s").retryable).toBe(true);
  });

  it("terminal codes are not retryable", () => {
    expect(hubError("unknown-session", "no such id").retryable).toBe(false);
    expect(hubError("denied", "kill not permitted").retryable).toBe(false);
  });

  it("explicit retryable overrides the default", () => {
    expect(hubError("unknown-session", "x", { retryable: true }).retryable).toBe(true);
  });

  it("carries structured cause, never a thrown Error", () => {
    const e = hubError("timeout", "late", { cause: { cmdId: "cli-1" } });
    expect(e.cause).toEqual({ cmdId: "cli-1" });
  });
});

describe("op registry", () => {
  it("exposes the thirteen ops of the vocabulary", () => {
    expect(OP_NAMES).toEqual([
      "list",
      "attention",
      "answer",
      "assign",
      "send",
      "tool",
      "spawn",
      "kill",
      "archive",
      "logTail",
      "summaries",
      "agent",
      "sessions",
      "ping",
    ]);
  });
});

describe("CommandSurface contract", () => {
  it("dispatch echoes cmdId and wraps errors as values", async () => {
    const surface: CommandSurface = {
      async dispatch(req: CommandRequest): Promise<CommandReply> {
        if (req.op === "kill") return { ok: false, error: hubError("denied", "agent session") };
        return { ok: true, value: { echoed: req.cmdId } };
      },
      ops: () => [...OP_NAMES],
    };
    const ok = await surface.dispatch({ cmdId: "cli-1-2", op: "list", args: {}, by: "cli" });
    expect(ok).toEqual({ ok: true, value: { echoed: "cli-1-2" } });
    const err = await surface.dispatch({ cmdId: "cli-1-3", op: "kill", args: {}, by: "cli" });
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error.code).toBe("denied");
  });
});
