// web/src/detail-routes.test.ts — live smoke over the detail/archive/agent
// routes (docs/04-web.md §Session detail, §Routes /archive*, §Agent page):
// adapter-style async ports (a real log file on disk + an archive record),
// fetch against the running server, key strings asserted. Complements the
// pure renderer tests in detail-page.test.ts and route shapes in
// server.test.ts. Never touches the real ~/.hub.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionStore, EventBus, SessionRecord, StatusFile, StatusStore, SummaryStore, CommandSurface } from "@yurifrl/hub";
import { startHubWeb } from "./server";
import type { HubWebDeps, HubWebArchive, HubWebLogs } from "./types";

let dataRoot: string;
beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "hub-web-smoke-"));
  // a real log file read through an adapter-style port
  mkdirSync(join(dataRoot, "logs"), { recursive: true });
  const lines = [
    { t: "2026-08-30T14:02:00.000Z", sessionId: "tilt", kind: "system", text: "session_start attached=true" },
    { t: "2026-08-30T14:03:00.000Z", sessionId: "tilt", kind: "prompt", text: "deploy canary to staging" },
    { t: "2026-08-30T14:04:00.000Z", sessionId: "tilt", kind: "tool", text: "gh api /repos/x/y", meta: { tool: "Bash" } },
    { t: "2026-08-30T14:04:01.000Z", sessionId: "tilt", kind: "result", text: "200 ok", meta: { tool: "Bash", ok: true, durationMs: 800 } },
    { t: "2026-08-30T14:05:00.000Z", sessionId: "tilt", kind: "message", text: "canary deployed" },
  ];
  writeFileSync(join(dataRoot, "logs", "tilt.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // an archive record (docs/02 §archive shape)
  mkdirSync(join(dataRoot, "archive", "2026-08"), { recursive: true });
  const record: SessionRecord = {
    status: "closing", kind: "peer", cwd: "/w", title: "old work", model: "m", phase: "idle",
    log: "logs/closed1.jsonl", toolCounts: {}, turns: 3,
    startedAt: "2026-08-29T15:09:44.500Z", lastActivity: "2026-08-29T16:59:40.900Z",
  };
  writeFileSync(
    join(dataRoot, "archive", "2026-08", "closed1.json"),
    JSON.stringify({ ...record, closedAt: "2026-08-29T18:44:00.000Z", closedBy: "cli", finalSummary: "done and dusted", resolutions: [] }),
  );
  const status: StatusFile = {
    version: 1, startedAt: new Date(0).toISOString(), pid: process.pid, nextAttentionId: 1,
    digest: "watching",
    sessions: { tilt: { ...record, status: "open", phase: "working", title: "deploy canary", phaseHistory: [{ phase: "working", at: "2026-08-30T14:02:00.000Z" }] } },
    attention: [],
    archived: [{ id: "closed1", path: "archive/2026-08/closed1.json", closedAt: "2026-08-29T18:44:00.000Z" }],
  };
  writeFileSync(join(dataRoot, "status.json"), JSON.stringify(status));
});
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));

const readFile = async (p: string): Promise<string | null> => {
  try { return await Bun.file(p).text(); } catch { return null; }
};

const logs: HubWebLogs = {
  tail: async (id: string, since?: string) => {
    const raw = await readFile(join(dataRoot, "logs", `${id}.jsonl`));
    if (raw === null) return [];
    const all = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { t: string; kind: string; text: string; meta?: Record<string, unknown> });
    return since === undefined ? all : all.filter((l) => Date.parse(l.t) > Date.parse(since));
  },
} as unknown as HubWebLogs;

const archive: HubWebArchive = {
  list: async () => {
    const raw = await readFile(join(dataRoot, "archive", "2026-08", "closed1.json"));
    if (raw === null) return [];
    const r = JSON.parse(raw) as { closedAt: string; closedBy: string; finalSummary: string };
    return [{ id: "closed1", closedAt: r.closedAt, closedBy: r.closedBy, finalSummary: r.finalSummary, path: "archive/2026-08/closed1.json" }];
  },
  read: async (id: string) => {
    if (id !== "closed1") return null;
    const raw = await readFile(join(dataRoot, "archive", "2026-08", "closed1.json"));
    if (raw === null) return null;
    const r = JSON.parse(raw) as Record<string, unknown>;
    const { closedAt, closedBy, finalSummary, resolutions, ...record } = r as never as SessionRecord & Record<string, unknown>;
    return { id, record, closedAt: closedAt as string, closedBy: closedBy as string, finalSummary: finalSummary as string, resolutions: (resolutions as never) ?? [] };
  },
} as unknown as HubWebArchive;

describe("live smoke — detail + archive + agent pages over HTTP", () => {
  it("serves every page with the documented content", async () => {
    const statusStore: StatusStore = {
      read: async () => ({ ok: true, value: JSON.parse(await Bun.file(join(dataRoot, "status.json")).text() as string) }),
      update: async () => ({ ok: false, error: { code: "denied", message: "ro", retryable: false } }),
    };
    const summaries: SummaryStore = { append: async () => ({ ok: true, value: undefined }), tail: async () => ({ ok: true, value: [] }) };
    const attention: AttentionStore = {
      list: () => ({ ok: true, value: [] }),
      raise: async () => ({ ok: false, error: { code: "denied", message: "x", retryable: false } }),
      resolve: async () => ({ ok: false, error: { code: "denied", message: "x", retryable: false } }),
    };
    const bus: EventBus = { publish: () => {}, subscribe: () => () => {} };
    const commands: CommandSurface = { dispatch: async () => ({ ok: true, value: null }), ops: () => [] };
    const deps: HubWebDeps = { port: 0, stores: { status: statusStore, summaries, attention }, bus, commands, logs, archive };
    const one = await startHubWeb(deps);
    const base = `http://127.0.0.1:${one.port}`;

    // open detail: full log, timeline, tool bars, send box
    const detail = await (await fetch(`${base}/session/tilt`)).text();
    expect(detail).toContain("deploy canary to staging");
    expect(detail).toContain("linked, not embedded");
    expect(detail).toContain("tool bars");
    expect(detail).toContain("send-form");
    expect(detail).toContain("seg-working");

    // ?since= cursor narrows
    const sinceBody = await (await fetch(`${base}/session/tilt?since=2026-08-30T14:03:00.000Z`)).text();
    expect(sinceBody).not.toContain("deploy canary to staging");
    expect(sinceBody).toContain("canary deployed");

    // archive index + detail
    const index = await (await fetch(`${base}/archive`)).text();
    expect(index).toContain("closed1");
    const archived = await (await fetch(`${base}/archive/closed1`)).text();
    expect(archived).toContain("ARCHIVED");
    expect(archived).toContain("done and dusted");
    expect(archived).toContain("closed — read-only");
    expect((await fetch(`${base}/archive/ghost`)).status).toBe(404);
    // /session/:id over an archived id → archived flavor
    const viaSession = await (await fetch(`${base}/session/closed1`)).text();
    expect(viaSession).toContain("ARCHIVED");

    // agent page: no agent session → empty state
    const agent = await (await fetch(`${base}/agent`)).text();
    expect(agent).toContain("no hub agent running");

    await one.stop();
  });
});
