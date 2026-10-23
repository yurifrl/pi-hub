import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUnixSocketServer, type ReportFrame } from "../adapters/unix_socket";
import { runTranscriptBridge, translate } from "./transcript_bridge";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bridge-"));
  dirs.push(d);
  return d;
};
// Real-time poll is deliberate: the bridge polls real files and a real unix socket on
// wall-clock intervals, so fake timers cannot drive it; the loop awaits the observable
// condition, not a guess.
const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(20);
  if (!pred()) throw new Error("timeout waiting for condition");
};

const ID = "11111111-2222-3333-4444-555555555555";
const msg = (role: string, content: unknown[]): string => `${JSON.stringify({ type: "message", message: { role, content } })}\n`;

test("translate maps user/assistant/tool lines to reporter frames", () => {
  expect(translate("s", { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } })).toEqual([
    { frame: "user_message", payload: { sessionId: "s", text: "hi" } },
  ]);
  const out = translate("s", {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", name: "bash", arguments: { c: 1 } }] },
  });
  expect(out.map((f) => f.frame)).toEqual(["assistant_message", "tool_call"]);
  expect(translate("s", { type: "title" })).toEqual([]);
});

test("runTranscriptBridge announces, streams lines, ends quiet sessions, retries until hub is up", async () => {
  const root = tmp();
  const sessions = join(root, "sessions");
  mkdirSync(join(sessions, "-tmp-proj"), { recursive: true });
  const file = join(sessions, "-tmp-proj", `2026_${ID}.jsonl`);
  writeFileSync(file, msg("user", [{ type: "text", text: "hello" }]));
  const sock = join(root, "hub.sock");
  const ac = new AbortController();
  const logs: string[] = [];
  const run = runTranscriptBridge({
    sock,
    sessionsRoot: sessions,
    stateFile: join(root, "tails-state.json"),
    quietMs: 300,
    pollMs: 30,
    retryMs: 50,
    startMs: 0,
    signal: ac.signal,
    log: (l) => logs.push(l),
  });

  // hub is down at boot: retry loop, not an exit
  await waitFor(() => logs.length > 0);
  expect(logs[0]).toBe("hub unreachable — retrying every 2s");

  const frames: ReportFrame[] = [];
  const server = startUnixSocketServer({
    socketPath: sock,
    hubInfo: { version: 1, startedAt: "2026-10-21T00:00:00.000Z" },
    dispatch: async () => ({ ok: true, result: {} }),
    onReport: (f) => frames.push(f),
  });
  expect((await server.start()).ok).toBe(true);

  await waitFor(() => frames.some((f) => f.frame === "user_message"));
  expect(frames[0]!.frame).toBe("session_start");
  expect(frames[0]!.sessionId).toBe(ID);
  expect(frames[0]!.attached).toBe(true);
  expect(frames.find((f) => f.frame === "user_message")!.text).toBe("hello");

  appendFileSync(file, msg("assistant", [{ type: "text", text: "yo" }]));
  await waitFor(() => frames.some((f) => f.frame === "assistant_message"));
  await waitFor(() => frames.some((f) => f.frame === "agent_end"));

  ac.abort();
  await run;
  await server.close();
});
