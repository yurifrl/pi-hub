// lib/domain/omp_sessions.test.ts — the pure machine-wide inventory logic
// (docs/02 §sessions): transcript-line parsing, fact extraction, roster merge.

import { describe, it, expect } from "bun:test";
import {
  clip,
  cwdFromDir,
  factFromHead,
  firstUserText,
  hasFarewell,
  idFromName,
  mergeFacts,
  modelFromLines,
  parseLine,
  textOf,
  OMP_SESSION_STALE_MS,
  type TranscriptBlob,
} from "./omp_sessions";

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe("omp_sessions — transcript parsing", () => {
  it("textOf joins text content only", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "one " },
        { type: "toolCall", name: "t" },
        { type: "text", text: "two" },
      ],
    };
    expect(textOf(msg)).toBe("one  two");
    expect(clip(textOf(msg))).toBe("one two");
  });

  it("clip collapses whitespace and truncates with …", () => {
    expect(clip("a\n  b\tc")).toBe("a b c");
    expect(clip("x".repeat(200), 10)).toBe("xxxxxxxxxx…");
    expect(clip("short", 10)).toBe("short");
  });

  it("idFromName takes the trailing UUID; falls back to the bare name", () => {
    expect(idFromName("2026-10-21T01-57-46-917Z_01a15c2d-c925-761c-a728-d61611e7cad3.jsonl")).toBe(
      "01a15c2d-c925-761c-a728-d61611e7cad3",
    );
    expect(idFromName("weird.jsonl")).toBe("weird");
  });

  it("cwdFromDir decodes omp's flattened dir names", () => {
    expect(cwdFromDir("-Users-yuri-proj")).toBe("/Users/yuri/proj");
    expect(cwdFromDir("-.omp-wt-wt-1")).toBe("/.omp/wt/wt/1"); // omp's own lossy rule, mirrored
  });

  it("parseLine rejects garbage and non-objects", () => {
    expect(parseLine("{not json")).toBeNull();
    expect(parseLine("[1,2]")).toBeNull();
    expect(parseLine("null")).toBeNull();
    const ok = parseLine(line({ type: "message" }));
    expect(ok).not.toBeNull();
    expect(ok?.type).toBe("message");
  });

  it("firstUserText takes the first user message; modelFromLines the last model_change", () => {
    const lines = [
      parseLine(line({ type: "session", id: "s1" }))!,
      parseLine(line({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello hub" }] } }))!,
      parseLine(line({ type: "model_change", model: "m1" }))!,
      parseLine(line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }))!,
      parseLine(line({ type: "model_change", model: "m2" }))!,
    ];
    expect(firstUserText(lines)).toBe("hello hub");
    expect(modelFromLines(lines)).toBe("m2");
    expect(modelFromLines([])).toBe("");
  });

  it("hasFarewell: session_end event or goodbye text; nothing else", () => {
    const end = [parseLine(line({ type: "session_end" }))!];
    const bye = [
      parseLine(line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Goodbye!" }] } }))!,
    ];
    const work = [parseLine(line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "still going" }] } }))!];
    expect(hasFarewell(end)).toBe(true);
    expect(hasFarewell(bye)).toBe(true);
    expect(hasFarewell(work)).toBe(false);
    expect(hasFarewell([])).toBe(false);
  });
});

describe("omp_sessions — factFromHead", () => {
  const blob = (head: string, tail = ""): TranscriptBlob => ({
    file: { dir: "-Users-yuri-proj", name: "2026-10-21T00-00-00-000Z_11111111-2222-4333-8444-555555555555.jsonl", mtimeMs: 1_000 },
    head,
    tail,
  });

  it("extracts id, cwd, first-user title, model, mtime", () => {
    const f = factFromHead(
      blob(
        [
          line({ type: "session", id: "ignored" }),
          line({ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the tests" }] } }),
          line({ type: "model_change", model: "glm-5.3" }),
        ].join("\n"),
      ),
    );
    expect(f.sessionId).toBe("11111111-2222-4333-8444-555555555555");
    expect(f.cwd).toBe("/Users/yuri/proj");
    expect(f.title).toBe("fix the tests");
    expect(f.model).toBe("glm-5.3");
    expect(f.lastActivityMs).toBe(1_000);
    expect(f.saidBye).toBe(false);
  });

  it("title falls back to the file stem when no user message exists", () => {
    const f = factFromHead(blob(line({ type: "session", id: "x" })));
    expect(f.title).toBe("2026-10-21T00-00-00-000Z_11111111-2222-4333-8444-555555555555");
  });

  it("saidBye reads the tail, not just the head", () => {
    const f = factFromHead(blob(line({ type: "session" }), line({ type: "session_end" })));
    expect(f.saidBye).toBe(true);
  });
});

describe("omp_sessions — mergeFacts (roster-first)", () => {
  const fact = (over: Partial<Parameters<typeof mergeFacts>[1][number]> = {}) => ({
    sessionId: "f-1",
    cwd: "/w",
    title: "t",
    model: "m",
    lastActivityMs: 100_000,
    saidBye: false,
    ...over,
  });

  it("roster wins: a known id keeps its hub row untouched", () => {
    const roster = {
      "f-1": {
        id: "f-1",
        status: "open" as const,
        kind: "worker" as const,
        cwd: "/hub",
        title: "t",
        model: "m",
        phase: "working" as const,
        log: "logs/f-1.jsonl",
        toolCounts: {},
        turns: 0,
        startedAt: new Date(0).toISOString(),
        lastActivity: new Date(0).toISOString(),
      },
    };
    const { sessions, detached } = mergeFacts(roster, [fact()], 100_001);
    expect(sessions).toEqual([roster["f-1"]]);
    expect(detached).toEqual([]);
  });

  it("fresh unknown fact → detached session row in the machine shape", () => {
    const { sessions, detached } = mergeFacts({}, [fact()], 100_000 + OMP_SESSION_STALE_MS);
    expect(detached).toEqual([]);
    expect(sessions).toEqual([
      {
        id: "f-1",
        status: "detached",
        kind: "peer",
        cwd: "/w",
        title: "t",
        model: "m",
        phase: "working",
        startedAt: new Date(100_000).toISOString(),
        lastActivity: new Date(100_000).toISOString(),
      },
    ]);
  });

  it("stale unknown fact → counted in detached, not shown", () => {
    const { sessions, detached } = mergeFacts({}, [fact()], 100_000 + OMP_SESSION_STALE_MS + 1);
    expect(sessions).toEqual([]);
    expect(detached).toEqual(["f-1"]);
  });
});
