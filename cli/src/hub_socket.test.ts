// cli/src/hub_socket.test.ts — socket client contract (docs/02 §hub.sock,
// docs/03 §bin boot sequence) against a real in-process fake hub server.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubCmd } from "./hub_socket";

let dir: string;
let sockPath: string;
let stopServer: (() => void) | null = null;

/** Fake hub: newline-JSON frames, scripted reply behavior. */
type FakeHubOpts = {
  hubVersion?: number;
  /** reply result for one cmd frame; return undefined to stay silent */
  onCmd?: (frame: Record<string, unknown>) => unknown;
  /** raw frames to send instead of a normal reply (error frames, garbage) */
  onCmdRaw?: (frame: Record<string, unknown>) => string[];
};

const startFakeHub = (opts: FakeHubOpts = {}): void => {
  const hello = JSON.stringify({
    v: 1,
    ch: "hello",
    hub: { version: opts.hubVersion ?? 1, startedAt: "2026-08-31T00:00:00.000Z" },
  });
  // per-connection buffers kept outside socket.data — Bun 1.3.14 drops data
  // events when open() mutates socket.data (observed on 1.3.14 macOS arm64)
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
            if (opts.onCmdRaw) {
              for (const raw of opts.onCmdRaw(frame)) socket.write(raw.endsWith("\n") ? raw : raw + "\n");
              continue;
            }
            const result = opts.onCmd?.(frame);
            if (result === undefined) continue;
            socket.write(JSON.stringify({ v: 1, ch: "reply", cmdId: frame.cmdId, ok: true, result }) + "\n");
            continue;
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
  stopServer = () => server.stop(true);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-sock-test-"));
  sockPath = join(dir, "test.sock");
});

afterEach(() => {
  stopServer?.();
  stopServer = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("hubCmd", () => {
  it("happy path: cmd frame carries v/ch/cmdId/op/args; reply result returned", async () => {
    let seen: Record<string, unknown> | null = null;
    startFakeHub({
      onCmd: (frame) => {
        seen = frame;
        return { echo: true };
      },
    });
    const out = await hubCmd(sockPath, "send", { sessionId: "s-1", text: "hi" }, 2000);
    expect(out).toEqual({ result: { echo: true } });
    const f = seen as Record<string, unknown> | null;
    expect(f).not.toBeNull();
    expect(f?.v).toBe(1);
    expect(f?.ch).toBe("cmd");
    expect(typeof f?.cmdId).toBe("string");
    expect((f?.cmdId as string).startsWith("cli-")).toBe(true);
    expect(f?.op).toBe("send");
    expect(f?.args).toEqual({ sessionId: "s-1", text: "hi" });
  });

  it("missing socket → unavailable-hub", async () => {
    const out = await hubCmd(join(dir, "nope.sock"), "list", {}, 2000);
    expect("error" in out && out.error.code).toBe("unavailable-hub");
  });

  it("plain file where socket should be → unavailable-hub", async () => {
    const { writeFileSync } = await import("node:fs");
    const plain = join(dir, "plain.sock");
    writeFileSync(plain, "not a socket");
    const out = await hubCmd(plain, "list", {}, 2000);
    expect("error" in out && out.error.code).toBe("unavailable-hub");
  });

  it("reply ok:false error.code=busy → denied HubError carrying busy message", async () => {
    startFakeHub({
      onCmdRaw: (frame) => [JSON.stringify({ v: 1, ch: "reply", cmdId: frame.cmdId, ok: false, error: { code: "busy", message: "agent already running" } })],
    });
    const out = await hubCmd(sockPath, "agent", {}, 2000);
    expect("error" in out && out.error.code).toBe("denied");
    if ("error" in out) expect(out.error.message).toBe("agent already running");
  });

  it("hub error frame bad-version → unavailable-hub", async () => {
    startFakeHub({
      onCmdRaw: () => [JSON.stringify({ v: 1, ch: "error", error: { code: "bad-version", message: "version mismatch" } })],
    });
    const out = await hubCmd(sockPath, "list", {}, 2000);
    expect("error" in out && out.error.code).toBe("unavailable-hub");
  });

  it("hello with wrong hub version → unavailable-hub", async () => {
    startFakeHub({ hubVersion: 2 });
    const out = await hubCmd(sockPath, "list", {}, 2000);
    expect("error" in out && out.error.code).toBe("unavailable-hub");
    if ("error" in out) expect(out.error.message).toContain("version mismatch");
  });

  it("deadline before reply → timeout", async () => {
    startFakeHub({
      onCmd: () => undefined, // never replies
    });
    const out = await hubCmd(sockPath, "send", {}, 80);
    expect("error" in out && out.error.code).toBe("timeout");
  });

  it("malformed reply frame → unavailable-hub (protocol class)", async () => {
    startFakeHub({
      onCmdRaw: () => ["not-json-at-all\n"],
    });
    const out = await hubCmd(sockPath, "list", {}, 2000);
    expect("error" in out && out.error.code).toBe("unavailable-hub");
  });

  it("reply with mismatched cmdId → unavailable-hub (protocol class)", async () => {
    startFakeHub({
      onCmdRaw: () => [JSON.stringify({ v: 1, ch: "reply", cmdId: "cli-other-99", ok: true, result: {} })],
    });
    const out = await hubCmd(sockPath, "list", {}, 2000);
    expect("error" in out && out.error.code).toBe("unavailable-hub");
  });
});
