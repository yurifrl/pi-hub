// web/src/console-page.test.ts — the attention console renderer (docs/04-web.md
// §Main page): exact top-down order, kind chips + three verbs, POST paths,
// hue via CSS vars, keyboard + filter, agent-off fallback. Pure renderer
// tests via consolePage() + string assertions; SSE fan-out is shape-tested in
// server.test.ts.

import { describe, expect, it } from "bun:test";
import type { StatusFile, SummaryLine } from "@yurifrl/hub";
import { CSP, consolePage, fmtDuration } from "./html";
import { buildSnapshot, synthesizedDigest } from "./snapshot";

// ---- fixture mirroring the docs/04 wireframe state ----

const session = (over: Partial<StatusFile["sessions"][string]>): StatusFile["sessions"][string] => ({
  status: "open",
  kind: "peer",
  cwd: "/tmp",
  title: "test session",
  model: "test-model",
  phase: "working",
  log: "logs/x.jsonl",
  toolCounts: {},
  turns: 0,
  startedAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  ...over,
});

const status: StatusFile = {
  version: 1,
  startedAt: new Date(0).toISOString(),
  pid: 1,
  nextAttentionId: 3,
  digest: "tilt needs approval · deploy canary 2/3 · docs idle 12m",
  sessions: {
    tilt: session({ phase: "waiting", title: "rate limit hit on POST /deploy", description: "rate limit hit" }),
    canary: session({ phase: "working", description: "deploy 2/3" }),
    docs: session({ phase: "idle", title: "docs idle 12m" }),
  },
  attention: [
    { id: "att-1", sessionId: "tilt", kind: "approval", text: "rate limit hit on POST /deploy — approve retry?", createdAt: new Date(0).toISOString() },
    { id: "att-2", sessionId: "docs", kind: "idle", text: "docs idle 12m — assign or kill", createdAt: new Date(0).toISOString() },
    { id: "att-3", sessionId: "canary", kind: "question", text: "which registry?", createdAt: new Date(0).toISOString(), resolvedAt: new Date(1).toISOString(), answer: "ghcr" },
    { id: "att-4", sessionId: "canary", kind: "blocked", text: "registry unreachable", createdAt: new Date(0).toISOString() },
  ],
  archived: [],
};

const summaries: SummaryLine[] = [
  { t: new Date(1).toISOString(), sessionId: "tilt", kind: "resolution", text: "resolved att-1 (approval): approve retry", by: "web" },
  { t: new Date(0).toISOString(), sessionId: "canary", kind: "summary", text: "deploy 2/3 rolling ok", by: "agent" },
];

const snapshot = buildSnapshot(status);
const page = consolePage(snapshot, { accent: "#70e1c4", ok: "#3fd68f", warn: "#f5c04e", err: "#ff7a9a", muted: "#8b97b0" }, summaries);

const indexOfAll = (haystack: string, needles: string[]): boolean =>
  needles.every((n, i) => i === 0 || haystack.indexOf(needles[i - 1]!) < haystack.indexOf(n!));

describe("console page — exact top-down order (docs/04 §Main page)", () => {
  it("renders header, digest, attention, running, idle, stream, summary rail in order", () => {
    expect(
      indexOfAll(page, [
        "<title>hub console</title>",
        'id="digest">tilt needs approval',
        'id="attention-list"',
        'data-item="att-1"',
        'id="running-list"',
        'data-session="canary"',
        'id="idle-list"',
        'data-session="docs"',
        'id="stream-chip"',
        'id="summary-list"',
      ]),
    ).toBe(true);
  });

  it("renders the agent-on marker from the snapshot", () => {
    expect(page).toContain("○ agent on");
  });

  it("synthesizes the digest when the agent is off", () => {
    const { digest: _d, ...agentOff } = status;
    const off = buildSnapshot(agentOff);
    expect(off.digest).toBe(synthesizedDigest(off.attention, off.sessions));
    expect(off.digest).toBe("3 need you · 2 running · 1 idle");
  });
});

describe("attention cards — kind chips + three verbs on every kind", () => {
  it("tags kind chips for approval, question, blocked, idle", () => {
    // open items render approval / idle / blocked chips…
    expect(page).toContain(`data-kind="approval"`);
    expect(page).toContain(`data-kind="blocked"`);
    expect(page).toContain(`data-kind="idle"`);
    expect(page).toContain("⚠ approval");
    expect(page).toContain("⛔ blocked");
    // …and the client chip map covers all four kinds (same verbs for every kind)
    expect(page).toContain("approval: \"\\u26a0\"");
    expect(page).toContain("question:");
    expect(page).toContain("blocked: \"\\u26d4\"");
    expect(page).toContain("idle: \"\\ud83d\\udca4\"");
  });

  it("renders the answer input posting to /api/answer", () => {
    expect(page).toContain('data-answer="att-1"');
    expect(page).toContain('/api/answer');
    expect(page).toContain('name="text"');
  });

  it("renders dismiss ✕ posting to /api/dismiss", () => {
    expect(page).toContain('data-dismiss="att-1"');
    expect(page).toContain("/api/dismiss");
    expect(page).toContain("✕");
  });

  it("renders open → linking to /session/:id", () => {
    expect(page).toContain('href="/session/tilt"');
  });

  it("hides resolved items", () => {
    expect(page).not.toContain('data-item="att-3"');
  });

  it("draws the warn border via the warn token var — no hardcoded hex", () => {
    expect(page).toContain("warn-border");
    expect(page).toContain("--warn:");
  });
});

describe("running strip + idle-assign", () => {
  it("renders phase word, description, link; waiting carries the attention count", () => {
    expect(page).toContain('class="phase phase-waiting"');
    expect(page).toContain("1 attention · ");
    expect(page).toContain('class="phase phase-working"');
  });

  it("renders idle-assign cards with idle-for and assign input posting to /api/assign", () => {
    expect(page).toContain('data-assign="docs"');
    expect(page).toContain("/api/assign");
    expect(page).toContain("idle ");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(12 * 60_000)).toBe("12m");
    expect(fmtDuration(3 * 3_600_000)).toBe("3h");
    expect(fmtDuration(2 * 86_400_000)).toBe("2d");
  });
});

describe("collapsed stream", () => {
  it("renders a collapsed ▸ stream chip and hidden panel — toggling sends no request", () => {
    expect(page).toContain("▸ stream");
    expect(page).toContain('id="stream-panel" hidden');
    expect(page).toContain("streamOpen = !streamOpen");
    // the chip click branch toggles locally — no POST request for the toggle
    const click = page.slice(page.indexOf("document.addEventListener(\"click\""), page.indexOf("// ---- keyboard"));
    expect(click).toContain("streamOpen = !streamOpen");
    expect(click).toContain("/api/dismiss");
    expect(click).not.toContain("/api/answer");
  });

  it("buffers log events into a bounded ring, newest at bottom", () => {
    expect(page).toContain("logRing");
    expect(page).toContain("logRing.length > 500");
    expect(page).toContain("scrollTop = el.scrollHeight");
  });
});

describe("summary rail", () => {
  it("renders newest-first per-session tinted lines with links", () => {
    const rail = page.slice(page.indexOf('id="summary-list"'));
    expect(rail.indexOf("resolved att-1")).toBeLessThan(rail.indexOf("deploy 2/3"));
    expect(rail).toContain('href="/session/tilt"');
    expect(rail).toContain('class="summary-line resolution"');
  });

  it("renders resolution lines with the answer inline", () => {
    expect(page).toContain("resolved att-1 (approval): approve retry");
  });
});

describe("theme + hue", () => {
  it("emits token CSS vars from lib and per-session --hue-<id> vars", () => {
    expect(page).toContain("--accent: #70e1c4");
    expect(page).toContain("--warn: #f5c04e");
    expect(page).toContain("--hue-tilt:");
    expect(page).toContain("--hue-canary:");
    expect(page).toContain("--hue-docs:");
    expect(page).toContain('style="background:var(--hue-tilt)"');
  });
});

describe("keyboard + filter", () => {
  it("wires a / s / Enter / Esc and the client-side filter", () => {
    expect(page).toContain('id="filter"');
    expect(page).toContain('"a"');
    expect(page).toContain('"s"');
    expect(page).toContain('"/"');
    expect(page).toContain('"Escape"');
    expect(page).toContain("applyFilter");
    expect(page).toContain("data-filter=");
  });
});

describe("agent-off fallback (docs/04 §Agent page)", () => {
  const { digest: _d, agentSession: _a, ...agentOff } = status;
  const offPage = consolePage(
    buildSnapshot(agentOff),
    { accent: "#70e1c4", ok: "#3fd68f", warn: "#f5c04e", err: "#ff7a9a", muted: "#8b97b0" },
    summaries,
  );

  it("hides the attention + summary rails, keeps the stream", () => {
    expect(offPage).toContain('id="needs-you" hidden');
    expect(offPage).toContain('id="summary-rail" hidden');
    expect(offPage).toContain("○ agent off");
    expect(offPage).toContain("stream-only");
  });

  it("still renders running + idle sections", () => {
    expect(offPage).toContain('id="running-list"');
    expect(offPage).toContain('id="idle-list"');
  });
});

describe("plumbing", () => {
  it("ships the v1 CSP constant", () => {
    expect(CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
  });

  it("escapes session-controlled text", () => {
    const hostile = buildSnapshot({
      ...status,
      attention: [{ id: "att-x", sessionId: "tilt", kind: "question", text: '<script>alert("x")</script>', createdAt: new Date(0).toISOString() }],
    });
    const hostilePage = consolePage(hostile, { accent: "", ok: "", warn: "", err: "", muted: "" }, []);
    expect(hostilePage).not.toContain("<script>alert(");
    expect(hostilePage).toContain("&lt;script&gt;");
  });

  it("serves the snapshot as boot state", () => {
    expect(page).toContain('"agentOn":true');
  });
});
