// extensions/widget.test.ts — the 8-line attention widget (docs/05 §Widget):
// line budget, line-1 composition, hue bars per session, state transitions
// (idle / busy / attach / summary-flash), 250 ms debounce, offline degrade,
// NO_COLOR plain. Pure pieces tested directly; the controller through a
// manual Scheduler (docs/01 §Testing: tests run timers manually).
import { describe, it, expect } from "bun:test";

/** Yield one macrotask so the controller's subscribe promise resolves. */
const tick = async (): Promise<void> => {
    await new Promise<void>((r) => setTimeout(r, 0));
};
import {
    applyFrame,
    createWidgetController,
    decodeFrame,
    emptyWidgetModel,
    renderWidget,
    WIDGET_MAX_LINES,
    WIDGET_DEBOUNCE_MS,
    WIDGET_IDLE_MS,
    widgetColorEnabled,
    type WidgetFrame,
    type WidgetModel,
} from "./widget";
import type { AttentionItem, SummaryLine } from "@yurifrl/hub";
import type { Scheduler } from "@yurifrl/hub/ports/scheduler";

// ---- manual scheduler (docs/01: tests run timers manually) ----

const makeScheduler = (): {
    scheduler: Scheduler;
    run(): void;
    pending(): number;
} => {
    const fns: Array<() => void> = [];
    return {
        scheduler: {
            setTimeout(fn) {
                fns.push(fn);
                return () => {
                    const i = fns.indexOf(fn);
                    if (i >= 0) fns.splice(i, 1);
                };
            },
        },
        run: () => {
            const batch = [...fns];
            fns.length = 0;
            for (const fn of batch) fn();
        },
        pending: () => fns.length,
    };
};

// ---- host fake ----

const makeHost = () => {
    const paints: string[][] = [];
    let cleared = false;
    const host = {
        paints,
        get cleared() {
            return cleared;
        },
        setWidget: (lines: string[] | undefined) => {
            if (lines === undefined) {
                cleared = true;
                return;
            }
            paints.push(lines);
        },
    };
    return { host, paints };
};

// ---- fixtures ----

const item = (id: string, sessionId: string, kind: AttentionItem["kind"], text: string): AttentionItem => ({
    id,
    sessionId,
    kind,
    text,
    createdAt: "2026-08-30T17:52:19.400Z",
});

const summary = (text: string): SummaryLine => ({ t: "2026-08-30T18:00:00.000Z", sessionId: "s-1", kind: "summary", text, by: "hub-watcher" });

const baseModel = (): WidgetModel => {
    let m = emptyWidgetModel();
    for (const f of [
        { kind: "session_start", sessionId: "a3f2", attached: true, cwd: "~/work/api", title: "tilt" },
        { kind: "session_start", sessionId: "9d01", attached: false, cwd: "~/ops", title: "deploy" },
        { kind: "attention", item: item("att-1", "a3f2", "approval", "bun add zod → awaiting your approval") },
        { kind: "attention", item: item("att-2", "9d01", "question", "which env?") },
    ] as WidgetFrame[]) {
        m = applyFrame(m, f, 1000);
    }
    return m;
};

const render = (m: WidgetModel, overrides: Partial<Parameters<typeof renderWidget>[0]> = {}): string[] =>
    renderWidget({
        model: m,
        state: "busy",
        lastEventAt: 1000,
        now: 2000,
        sockPath: "~/.hub/hub.sock",
        color: false,
        ...overrides,
    });

// =====================================================================
// 1. Line budget (docs/05 CONTRACT: hard budget of 8, clip never wrap)
// =====================================================================

describe("widget line budget", () => {
    it("compact render: empty model → orientation + footer only", () => {
        const lines = render(emptyWidgetModel());
        expect(lines.length).toBe(2);
        expect(lines[0]).toContain("⚠0 ⏳0 💤0");
        expect(lines.at(-1)).toBe("~/.hub/hub.sock · summaries 0");
    });

    it("never exceeds 8 lines with 20 sessions and 9 attention items", () => {
        let m = baseModel();
        for (let i = 0; i < 18; i++) {
            m = applyFrame(m, { kind: "session_start", sessionId: `extra-${i}`, attached: false, cwd: "/tmp", title: `s${i}` }, 2000 + i);
        }
        for (let i = 0; i < 7; i++) {
            m = applyFrame(m, { kind: "attention", item: item(`att-x-${i}`, "a3f2", "blocked", `blocked ${i}`) }, 3000 + i);
        }
        const lines = render(m);
        expect(lines.length).toBeLessThanOrEqual(WIDGET_MAX_LINES);
        expect(lines.length).toBe(8);
    });

    it("rows clip, never wrap: a long description stays one line", () => {
        let m = baseModel();
        m = applyFrame(m, { kind: "tool_call", sessionId: "a3f2", tool: "x".repeat(200) }, 1500);
        const lines = render(m);
        expect(lines.length).toBeLessThanOrEqual(WIDGET_MAX_LINES);
        expect(lines[1]!.length).toBeLessThan(80);
    });
});

// =====================================================================
// 2. Line 1 composition (counts + top item + answer hint)
// =====================================================================

describe("widget line 1", () => {
    it("counts ⚠ = approval|question|blocked only; ⏳ = working|waiting; 💤 = idle", () => {
        let m = baseModel();
        // idle a3f2 → working count drops to 1 (deploy), idle count 1
        m = applyFrame(m, { kind: "phase", sessionId: "a3f2", phase: "idle" }, 1100);
        const lines = render(m);
        expect(lines[0]).toContain("⚠2 ⏳1 💤1");
    });

    it("top attention item + answer hint mirror the newest item", () => {
        const lines = render(baseModel());
        expect(lines[0]).toContain("tilt: bun add zod → awaiting your approval");
        expect(lines[0]).toContain("answer att-1: …");
    });

    it("idle attention items do not count into ⚠", () => {
        let m = baseModel();
        m = applyFrame(m, { kind: "attention", item: item("att-3", "9d01", "idle", "assigned: deploy") }, 1200);
        const lines = render(m);
        expect(lines[0]).toContain("⚠2"); // idle kind excluded from human count
        expect(lines[0]).toContain("answer att-1: …"); // newest human item still leads
    });
});

// =====================================================================
// 3. Session rows + hue bars (idempotent hash, shared lib math)
// =====================================================================

describe("widget hue bars", () => {
    it("session rows carry the same hue codes as the lib barrel computes", async () => {
        const { hueColorCodes } = await import("@yurifrl/hub");
        const lines = render(baseModel(), { color: true });
        const a3f2 = lines.find((l) => l.includes("▌") && l.includes("tilt"))!;
        expect(a3f2).toContain(`\x1b[${hueColorCodes("a3f2")}m▌`);
        // idempotent: same id → same codes on every row and every render
        const again = render(baseModel(), { color: true });
        expect(again.find((l) => l.includes("▌") && l.includes("tilt"))).toBe(a3f2);
    });

    it("NO_COLOR → plain: no escape sequences anywhere", () => {
        const lines = render(baseModel(), { color: false });
        for (const l of lines) expect(l).not.toMatch(/\x1b\[/);
        expect(lines.find((l) => l.includes("▌") && l.includes("tilt"))).toContain("▌tilt");
    });
});

// =====================================================================
// 4. States (docs/05 §Widget states) + debounce
// =====================================================================

describe("widget states", () => {
    it("idle state dims rows: strip → plain text, orientation dimmed", () => {
        const lines = render(baseModel(), { state: "idle", color: true });
        for (const l of lines.slice(1)) expect(l).not.toMatch(/\x1b\[3[0-9]m/); // hue stripped
    });

    it("attach state highlights exactly the attached row for one refresh", () => {
        const lines = render(baseModel(), { state: "attach", color: true, attachSessionId: "a3f2" });
        expect(lines[1]).toContain("\x1b[1m");
        const other = lines.find((l) => l.includes("deploy"));
        expect(other).not.toContain("\x1b[1m");
    });

    it("summary-flash: newest summary line occupies line 7 (no overflow)", () => {
        // one session, one attention item → no overflow; summary takes line 7
        let m = applyFrame(emptyWidgetModel(), { kind: "session_start", sessionId: "a3f2", attached: true, cwd: "~/work/api", title: "tilt" }, 1000);
        m = applyFrame(m, { kind: "attention", item: item("att-1", "a3f2", "approval", "bun add zod") }, 1100);
        m = applyFrame(m, { kind: "summary", line: summary("canary rollout finished") }, 1300);
        const lines = render(m);
        expect(lines[2]).toContain("◈ canary rollout finished");
        expect(lines.at(-1)).toContain("summaries 1");
    });

    it("overflow beats the summary slot: +N more attention items wins line 7", () => {
        const lines = render(baseModel());
        expect(lines[3]).toContain("+1 more attention items");
    });

    it("controller: 250 ms trailing debounce — burst of events costs one paint", async () => {
        const { scheduler, run, pending } = makeScheduler();
        const { host } = makeHost();
        let feedHandler: ((f: Record<string, unknown>) => void) | null = null;
        const subscribe = async () => {
            const handlers = new Set<(f: Record<string, unknown>) => void>();
            feedHandler = (f) => { for (const h of handlers) h(f); };
            return {
                ok: true as const,
                feed: {
                    on: (h: (f: Record<string, unknown>) => void) => { handlers.add(h); return () => handlers.delete(h); },
                    onClose: () => () => {},
                    close: () => {},
                },
            };
        };
        const c = createWidgetController({
            sockPath: "~/.hub/hub.sock",
            host,
            scheduler,
            subscribe: subscribe as never,
        });
        c.start();
        await tick();
        run(); // paint after connect
        const paintsBefore = host.paints.length;
        feedHandler!({ kind: "session_start", sessionId: "s-1", attached: false, cwd: "/tmp", title: "s-one" });
        feedHandler!({ kind: "user_message", sessionId: "s-1", text: "one" });
        feedHandler!({ kind: "user_message", sessionId: "s-1", text: "two" });
        feedHandler!({ kind: "user_message", sessionId: "s-1", text: "three" });
        expect(pending()).toBe(1); // still one timer — debounce coalesced the burst
        run();
        expect(host.paints.length).toBe(paintsBefore + 1); // exactly one paint for the burst
        expect(c.isOffline()).toBe(false); // live feed = not offline
        c.stop();
    });
});

// =====================================================================
// 5. Frame decode (docs/02 §Event frames → WidgetFrame)
// =====================================================================

describe("decodeFrame", () => {
    it("decodes the five reporter frames + attention/phase/summary", () => {
        expect(decodeFrame({ kind: "session_start", sessionId: "s1", attached: true, cwd: "/x" })).toEqual({
            kind: "session_start", sessionId: "s1", attached: true, cwd: "/x",
        });
        expect(decodeFrame({ kind: "attention", item: item("att-9", "s1", "blocked", "b") })).toMatchObject({ kind: "attention" });
        expect(decodeFrame({ kind: "phase", sessionId: "s1", phase: "working" })).toMatchObject({ kind: "phase" });
        expect(decodeFrame({ kind: "summary", sessionId: "s1", text: "t", by: "a" })).toMatchObject({ kind: "summary" });
    });

    it("drops malformed and unknown frames silently", () => {
        expect(decodeFrame({})).toBeNull();
        expect(decodeFrame({ kind: "wat" })).toBeNull();
        expect(decodeFrame({ kind: "user_message", sessionId: 42, text: "x" })).toBeNull();
    });
});

// =====================================================================
// 6. Model fold invariants
// =====================================================================

describe("applyFrame fold", () => {
    it("attention resolve removes the item; re-raise updates text in place (same id)", () => {
        let m = baseModel();
        m = applyFrame(m, { kind: "attention", item: { ...item("att-1", "a3f2", "approval", "b"), resolvedAt: "t" } }, 1400);
        expect(m.attention.find((i) => i.id === "att-1")).toBeUndefined();
        m = applyFrame(m, { kind: "attention", item: item("att-1", "a3f2", "approval", "updated") }, 1500);
        expect(m.attention.find((i) => i.id === "att-1")!.text).toBe("updated");
    });

    it("summary increments the footer count and keeps the newest line", () => {
        let m = baseModel();
        m = applyFrame(m, { kind: "summary", line: summary("first") }, 1300);
        m = applyFrame(m, { kind: "summary", line: summary("second") }, 1350);
        expect(m.summaryCount).toBe(2);
        expect(m.lastSummary!.text).toBe("second");
    });

    it("frames for unknown sessions are ignored (no phantom rows)", () => {
        const m = applyFrame(emptyWidgetModel(), { kind: "tool_call", sessionId: "ghost", tool: "t" }, 100);
        expect(Object.keys(m.sessions)).toEqual([]);
    });
});

// =====================================================================
// 7. Controller: offline degrade + NO_COLOR through the factory seam
// =====================================================================

describe("widget controller offline + NO_COLOR", () => {
    it("hub offline → static '(hub offline)' state, reconnect scheduled (backoff), no crash", async () => {
        const { scheduler, run, pending } = makeScheduler();
        const { host } = makeHost();
        const c = createWidgetController({
            sockPath: "~/.hub/hub.sock",
            host,
            scheduler,
            subscribe: async () => ({ ok: false, error: "offline" }),
            retryMinMs: 100,
            retryMaxMs: 200,
        });
        c.start();
        await tick();
        expect(host.paints.at(-1)).toEqual(["(hub offline)"]);
        expect(c.isOffline()).toBe(true);
        run(); // fire the backoff timer → reconnect attempt
        await tick(); // reconnect fails async → next backoff timer armed
        expect(pending()).toBe(1);
        c.stop();
        expect(host.cleared).toBe(true); // widget cleared on stop
    });

    it("NO_COLOR in env → painted lines carry no ANSI", async () => {
        const { scheduler, run } = makeScheduler();
        const { host } = makeHost();
        let feedHandler: ((f: Record<string, unknown>) => void) | null = null;
        const fakeFeed = async () => {
            const handlers = new Set<(f: Record<string, unknown>) => void>();
            feedHandler = (f) => { for (const h of handlers) h(f); };
            return {
                ok: true as const,
                feed: {
                    on: (h: (f: Record<string, unknown>) => void) => { handlers.add(h); return () => handlers.delete(h); },
                    onClose: () => () => {},
                    close: () => {},
                },
            };
        };
        const c = createWidgetController({
            sockPath: "~/.hub/hub.sock",
            host,
            scheduler,
            subscribe: fakeFeed as never,
            env: { NO_COLOR: "1" },
        });
        c.start();
        await tick();
        run();
        feedHandler!({ kind: "session_start", sessionId: "a3f2", attached: true, cwd: "~/w", title: "tilt" });
        run();
        const last = host.paints.at(-1)!;
        for (const l of last) expect(l).not.toMatch(/\x1b\[/);
        expect(last[1]).toContain("▌tilt");
        c.stop();
    });

    it("widgetColorEnabled: NO_COLOR set (any value) → plain", () => {
        expect(widgetColorEnabled({})).toBe(true);
        expect(widgetColorEnabled({ NO_COLOR: "1" })).toBe(false);
        expect(widgetColorEnabled({ NO_COLOR: "" })).toBe(true); // empty = unset per NO_COLOR spec
    });
});

// =====================================================================
// 8. Constants match the docs contract
// =====================================================================

describe("widget constants", () => {
    it("debounce 250ms, idle 30s, budget 8 (docs/05 §Widget)", () => {
        expect(WIDGET_DEBOUNCE_MS).toBe(250);
        expect(WIDGET_IDLE_MS).toBe(30_000);
        expect(WIDGET_MAX_LINES).toBe(8);
    });
});
