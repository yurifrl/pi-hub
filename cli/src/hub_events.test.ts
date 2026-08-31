// cli/src/hub_events.test.ts — hubSubscribe against a fake hub socket
// (docs/01 §Testing: fake the bus, never real sockets): hello subscribe
// handshake, event frame decode → FeedEvent, close notification, connect
// failure, version mismatch.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubSubscribe } from "./hub_events";

let dir: string;
let stop: (() => void) | null = null;
dir = mkdtempSync(join(tmpdir(), "hub-events-test-"));

afterEach(() => {
  stop?.();
  stop = null;
});

type HubConn = { write: (s: string) => void; destroyClient: () => void };
const conns: HubConn[] = [];

const startFakeHub = (opts: { hello?: string } = {}): string => {
  const sockPath = join(dir, `fake-${Math.random().toString(36).slice(2)}.sock`);
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
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.ch === "hello") {
            conns.push({
              write: (s) => socket.write(s + "\n"),
              destroyClient: () => socket.end(),
            });
            socket.write(
              (opts.hello ?? JSON.stringify({ v: 1, ch: "hello", hub: { version: 1, startedAt: "x" } })) + "\n",
            );
          }
        }
        buffers.set(socket, buffer);
      },
      close() {},
      error() {},
    },
  });
  stop = () => server.stop(true);
  return sockPath;
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("hubSubscribe", () => {
  it("handshakes and decodes event frames into FeedEvents (attention under `item`)", async () => {
    conns.length = 0;
    const sockPath = startFakeHub();
    const res = await hubSubscribe(sockPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const events: { topic: string; payload: unknown }[] = [];
    res.feed.on((evt) => events.push(evt));
    await tick();

    const hub = conns[0]!;
    hub.write(
      JSON.stringify({
        v: 1,
        ch: "event",
        kind: "log",
        sessionId: "s-a",
        t: 1756562400000,
        text: "bun test",
      }),
    );
    hub.write(
      JSON.stringify({
        v: 1,
        ch: "event",
        kind: "attention",
        item: { id: "att-1", sessionId: "s-a", kind: "approval", text: "approve?" },
      }),
    );
    hub.write(
      JSON.stringify({
        v: 1,
        ch: "event",
        kind: "phase",
        sessionId: "s-a",
        phase: "idle",
        at: "x",
      }),
    );
    await tick();

    expect(events.map((e) => e.topic)).toEqual(["log", "attention", "phase"]);
    expect(events[0]!.payload).toMatchObject({ sessionId: "s-a", text: "bun test" });
    expect(events[1]!.payload).toMatchObject({ id: "att-1" });
    res.feed.close();
  });

  it("malformed and unknown frames are ignored, never crash the feed", async () => {
    conns.length = 0;
    const sockPath = startFakeHub();
    const res = await hubSubscribe(sockPath);
    if (!res.ok) return;
    const events: unknown[] = [];
    res.feed.on((evt) => events.push(evt));
    await tick();
    const hub = conns[0]!;
    hub.write("{broken json");
    hub.write(JSON.stringify({ v: 1, ch: "event", kind: "wat" }));
    hub.write(JSON.stringify({ v: 1, ch: "reply", cmdId: "x", ok: true, result: {} }));
    hub.write(JSON.stringify({ v: 1, ch: "event", kind: "log", sessionId: "s-a", t: 1, text: "good" }));
    await tick();
    expect(events).toHaveLength(1);
    res.feed.close();
  });

  it("connection refused → ok:false with message, never throws", async () => {
    const res = await hubSubscribe(join(dir, "nope.sock"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("nope.sock");
  });

  it("version mismatch → ok:false with mismatch message", async () => {
    const sockPath = startFakeHub({
      hello: JSON.stringify({ v: 1, ch: "hello", hub: { version: 99, startedAt: "x" } }),
    });
    const res = await hubSubscribe(sockPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("version mismatch");
    await tick();
  });

  it("onClose fires when the hub closes the socket (offline degrade)", async () => {
    conns.length = 0;
    const sockPath = startFakeHub();
    const res = await hubSubscribe(sockPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    let closed = false;
    res.feed.onClose(() => {
      closed = true;
    });
    await tick();
    conns[0]!.destroyClient();
    await tick();
    await tick();
    expect(closed).toBe(true);
    res.feed.close();
  });
});
