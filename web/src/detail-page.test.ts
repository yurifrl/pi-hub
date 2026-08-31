// web/src/detail-page.test.ts — the session detail, archive, and agent page
// renderers (docs/04-web.md §Session detail, §Routes /archive*, §Agent page
// + docs/06 §agentSurface). Pure renderer tests via the html.ts functions +
// string assertions, mirroring console-page.test.ts style; route wiring is
// shape-tested in server.test.ts.

import { describe, expect, it } from "bun:test";
import type { SessionRecord } from "@yurifrl/hub";
import { agentPage, archivedSessionPage, archivePage, sessionPage } from "./html";
import type { AgentPageInfo, HubArchiveEntry, SessionDetail, SurfaceState } from "./types";

const THEME = { accent: "#70e1c4", ok: "#3fd68f", warn: "#f5c04e", err: "#ff7a9a", muted: "#8b97b0" };

const session = (over: Partial<SessionRecord>): SessionRecord => ({
  status: "open",
  kind: "peer",
  cwd: "/tmp",
  title: "deploy canary",
  model: "test-model",
  phase: "working",
  log: "logs/tilt.jsonl",
  toolCounts: { Bash: 2 },
  turns: 1,
  startedAt: "2026-08-30T14:02:00.000Z",
  lastActivity: "2026-08-30T14:12:00.000Z",
  ...over,
});

const entries = (kindTexts: [string, string, Record<string, unknown>?][]): SessionDetail["entries"] =>
  kindTexts.map(([kind, text, meta], i) => ({
    t: Date.parse(`2026-08-30T14:0${i}:00.000Z`),
    kind,
    text,
    ...(meta !== undefined ? { meta } : {}),
  }));

// ---- open flavor ----

const openDetail: SessionDetail & { flavor: "open" } = {
  flavor: "open",
  id: "tilt",
  record: session({
    phaseHistory: [
      { phase: "working", at: "2026-08-30T14:02:00.000Z" },
      { phase: "waiting", at: "2026-08-30T14:07:00.000Z" },
      { phase: "working", at: "2026-08-30T14:09:00.000Z" },
    ],
  }),
  entries: entries([
    ["system", "session_start attached=true"],
    ["prompt", "deploy canary to staging"],
    ["message", "reading deploy config…"],
    ["tool", "gh api …", { tool: "Bash" }],
    ["result", "200 ok", { tool: "Bash", ok: true, durationMs: 800 }],
    ["result", "boom", { tool: "Bash", ok: false, durationMs: 400 }],
  ]),
};

const openPage = sessionPage(openDetail, THEME);

describe("session detail — open flavor (docs/04 §Session detail)", () => {
  it("renders head with hue bar, phase, started, model — zero hex in the body", () => {
    expect(openPage).toContain("hub · tilt");
    expect(openPage).toContain("--hue-tilt");
    expect(openPage).toContain('id="phase-now"');
    expect(openPage).toContain("phase-working");
    expect(openPage).toContain("test-model");
    // hue via CSS vars only: no raw hex outside the injected theme block
    const body = openPage.slice(openPage.indexOf("</style>"));
    expect(body).not.toContain("#70e1c4");
  });

  it("renders the phase timeline from phaseHistory, newest right", () => {
    expect(openPage).toContain("timeline");
    expect(openPage).toContain("seg-waiting");
    const iWorking = openPage.indexOf("14:02");
    const iWaiting = openPage.indexOf("14:07");
    const iWorking2 = openPage.indexOf("14:09");
    expect(iWorking).toBeGreaterThan(-1);
    expect(iWaiting).toBeGreaterThan(iWorking);
    expect(iWorking2).toBeGreaterThan(iWaiting);
  });

  it("timeline falls back to the current phase only when phaseHistory is absent", () => {
    const bare = sessionPage({ ...openDetail, record: session({}) }, THEME);
    expect(bare).toContain("timeline");
    expect(bare.match(/<div class="timeline">.*?<\/div>/s)?.[0]).not.toContain("→");
  });

  it("renders the full log hue-tagged with the LINK label", () => {
    expect(openPage).toContain("linked, not embedded");
    expect(openPage).toContain("deploy canary to staging");
    expect(openPage).toContain("kind-prompt");
    expect(openPage).toContain("kind-tool");
  });

  it("renders tool bars grouped per tool with ok/err dots", () => {
    expect(openPage).toContain("tool bars");
    expect(openPage).toContain("Bash");
    expect(openPage).toContain("err-dot");
    expect(openPage).toContain("ok-dot");
  });

  it("renders the pinned send box posting to /api/send", () => {
    expect(openPage).toContain("send-form");
    expect(openPage).toContain('"/api/send"');
    expect(openPage).toContain("sessionId");
  });

  it("client script applies log/phase deltas for this session only + JSON ?since= tail", () => {
    expect(openPage).toContain('"/stream"');
    expect(openPage).toContain("d.sessionId === id");
    // the 5s poll safety net tails the JSON endpoint, never the HTML page
    // (pre-fix it fetched /session/:id?since= and JSON.parse()d the HTML)
    expect(openPage).toContain('"/api/session/" + encodeURIComponent(id) + "/log?since=" + lastT');
    expect(openPage).not.toContain('"/session/" + encodeURIComponent(id) + "?since=');
    expect(openPage).toContain('"tilt"');
  });

  it("escapes session text (no raw <script> injection from log content)", () => {
    const hostile = sessionPage(
      { ...openDetail, entries: entries([["prompt", '</script><script>alert(1)</script>']]) },
      THEME,
    );
    expect(hostile).toContain("&lt;/script&gt;");
  });
});

// ---- archived flavor ----

const archivedDetail: SessionDetail & { flavor: "archived" } = {
  flavor: "archived",
  id: "tilt",
  record: session({ status: "closing" }),
  closedAt: "2026-08-29T18:44:00.000Z",
  closedBy: "cli",
  finalSummary: "deployed canary 3/3, clean; rate limit resolved by Y.",
  resolutions: [
    {
      id: "att-3",
      sessionId: "tilt",
      kind: "question",
      text: "keep raw logs forever?",
      createdAt: "2026-08-29T15:40:12.300Z",
      resolvedAt: "2026-08-29T15:41:02.000Z",
      answer: "yes for v1",
    },
  ],
  entries: entries([
    ["system", "session_start attached=true"],
    ["system", "closed (hub_archive)"],
  ]),
};

const archivedPage = archivedSessionPage(archivedDetail, THEME);

describe("session detail — archived flavor (docs/04 §Session detail + docs/02 §archive)", () => {
  it("renders closed badge, close date, closedBy", () => {
    expect(archivedPage).toContain("ARCHIVED");
    expect(archivedPage).toContain("2026-08-29 18:44");
    expect(archivedPage).toContain("cli");
  });

  it("pins the final summary above the log and lists resolutions", () => {
    const iSummary = archivedPage.indexOf("deployed canary 3/3, clean");
    const iLog = archivedPage.indexOf("read-only");
    expect(iSummary).toBeGreaterThan(-1);
    expect(iSummary).toBeLessThan(iLog);
    expect(archivedPage).toContain("keep raw logs forever?");
    expect(archivedPage).toContain("yes for v1");
  });

  it("send box replaced by the read-only note; no live script", () => {
    expect(archivedPage).toContain("closed — read-only");
    expect(archivedPage).not.toContain("send-form");
    expect(archivedPage).not.toContain("EventSource");
  });
});

// ---- archive index ----

const archiveEntries: HubArchiveEntry[] = [
  { id: "s-new", closedAt: "2026-08-30T00:00:00.000Z", closedBy: "archive", finalSummary: "newer", path: "archive/2026-08/s-new.json" },
  { id: "s-old", closedAt: "2026-08-01T00:00:00.000Z", closedBy: "kill", finalSummary: "older", path: "archive/2026-08/s-old.json" },
];

describe("archive index (docs/04 §Routes /archive)", () => {
  it("groups by month with links to each detail, newest first", () => {
    const page = archivePage(archiveEntries, THEME);
    expect(page).toContain("2026-08");
    expect(page).toContain('href="/archive/s-new"');
    expect(page).toContain('href="/archive/s-old"');
    expect(page.indexOf("s-new")).toBeLessThan(page.indexOf("s-old"));
  });

  it("empty state when nothing archived", () => {
    expect(archivePage([], THEME)).toContain("no archived sessions");
  });
});

// ---- agent page ----

const agentInfo: AgentPageInfo = {
  sessionId: "s-agent",
  record: session({ kind: "agent", agentSurface: "watcher", title: "hub watcher" }),
  digest: "watching 3 threads · 1 needs you",
  counts: { approval: 1, question: 2, blocked: 0, idle: 3 },
  lastSummary: { t: "2026-08-30T14:00:00.000Z", sessionId: "s-agent", kind: "summary", text: "cycle done", by: "agent" },
};

describe("agent page (docs/04 §Agent page + docs/06 §agentSurface)", () => {
  it("empty-state when no hub agent runs — not an error", () => {
    const page = agentPage(null, null, THEME);
    expect(page).toContain("no hub agent running");
    expect(page).toContain("hub agent");
  });

  it("watcher surface: digest, attention counts, last summary, session link", () => {
    const page = agentPage(agentInfo, null, THEME);
    expect(page).toContain("watching 3 threads · 1 needs you");
    expect(page).toContain("c-approval");
    expect(page).toContain("c-idle");
    expect(page).toContain("cycle done");
    expect(page).toContain('href="/session/s-agent"');
  });

  it("pending surface renders the file-backed state sections", () => {
    const file: SurfaceState = {
      agent: "pending-agent",
      surface: "pending",
      revision: 7,
      updatedAt: "2026-08-30T14:00:00.000Z",
      headline: "3 diffs await review",
      sections: [{ title: "next up", lines: ["review api/deploy.ts", "review lib/theme.ts"], tone: "warn" }],
    };
    const pendingInfo = { ...agentInfo, record: session({ kind: "agent", agentSurface: "pending", title: "pending agent" }) };
    const page = agentPage(pendingInfo, file, THEME);
    expect(page).toContain("3 diffs await review");
    expect(page).toContain("next up");
    expect(page).toContain("review api/deploy.ts");
    expect(page).toContain("tone-warn");
    expect(page).toContain("rev 7");
  });

  it("stale surface (updatedAt > 5 min old) is marked stale", () => {
    const stale: SurfaceState = {
      agent: "pending-agent",
      surface: "pending",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      headline: "old",
    };
    const pendingInfo = { ...agentInfo, record: session({ kind: "agent", agentSurface: "pending" }) };
    expect(agentPage(pendingInfo, stale, THEME)).toContain("stale");
  });

  it("unknown agentSurface id → generic card with digest + session link, never a 404", () => {
    const unknownInfo = { ...agentInfo, record: session({ kind: "agent", agentSurface: "my-custom" }) };
    const page = agentPage(unknownInfo, null, THEME);
    expect(page).toContain("my-custom");
    expect(page).toContain("watching 3 threads · 1 needs you");
    expect(page).toContain('href="/session/s-agent"');
  });
});
