import { describe, expect, it } from "bun:test";
import { hubEventToFrame } from "./event_frames";

describe("hubEventToFrame", () => {
  it("log events become the reporter frame named by the log kind", () => {
    const f = hubEventToFrame({ topic: "log", payload: { t: 1, sessionId: "s1", kind: "assistant_message", text: "hi" } });
    expect(f).toEqual({ v: 1, ch: "event", kind: "assistant_message", t: 1, sessionId: "s1", text: "hi" });
  });

  it("archive status becomes a closed frame so clients drop the row", () => {
    const f = hubEventToFrame({ topic: "status", payload: { kind: "archive", id: "s1", path: "archive/x.json" } });
    expect(f).toEqual({ v: 1, ch: "event", kind: "closed", sessionId: "s1", path: "archive/x.json" });
  });

  it("other status changes keep frame kind 'status' and carry the change name", () => {
    const f = hubEventToFrame({ topic: "status", payload: { kind: "assign", sessionId: "s2", task: "t" } });
    expect(f).toEqual({ v: 1, ch: "event", kind: "status", change: "assign", sessionId: "s2", task: "t" });
  });

  it("attention payload is wrapped as item", () => {
    const f = hubEventToFrame({ topic: "attention", payload: { id: "att-1" } });
    expect(f).toEqual({ v: 1, ch: "event", kind: "attention", item: { id: "att-1" } });
  });

  it("malformed payloads yield null", () => {
    expect(hubEventToFrame({ topic: "log", payload: { kind: "tool_call" } })).toBeNull();
    expect(hubEventToFrame({ topic: "phase", payload: null })).toBeNull();
  });
});
