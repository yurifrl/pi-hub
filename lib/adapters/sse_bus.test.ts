// lib/adapters/sse_bus.test.ts — the /stream delta transport (docs/04-web.md
// §SSE contract), asserted through event replay, not sleeps (docs/01 §Testing).
import { describe, expect, it } from "bun:test";
import { createSseBus, formatSse, renderSseMessage } from "./sse_bus";
import type { SseMessage } from "./sse_bus";
import type { HubEvent } from "../domain/session";

const evt = (topic: HubEvent["topic"], payload: unknown): HubEvent => ({ topic, payload });

const ids = (msgs: SseMessage[]): number[] => msgs.map((m) => m.id!).filter((id) => id !== undefined);

describe("sse_bus — wire form", () => {
    it("renderSseMessage: event name = topic, data = JSON payload", () => {
        const m = renderSseMessage(7, evt("attention", { id: "att-6" }));
        expect(m.id).toBe(7);
        expect(m.event).toBe("attention");
        expect(m.data).toBe('{"id":"att-6"}');
    });

    it("formatSse emits id/event/data + blank terminator", () => {
        const out = formatSse(renderSseMessage(3, evt("log", { t: 1 })));
        expect(out).toBe("id: 3\nevent: log\ndata: {\"t\":1}\n\n");
    });

    it("formatSse omits the id line for unnumbered (snapshot) frames", () => {
        const out = formatSse({ event: "snapshot", data: '{"v":1}' });
        expect(out).toBe("event: snapshot\ndata: {\"v\":1}\n\n");
    });
});

describe("sse_bus — id assignment and ring", () => {
    it("publish numbers events monotonically", () => {
        const sse = createSseBus(10);
        const m1 = sse.publish(evt("log", 1));
        const m2 = sse.publish(evt("log", 2));
        expect(m1.id).toBe(1);
        expect(m2.id).toBe(2);
    });

    it("ring cap drops the oldest messages", () => {
        const sse = createSseBus(3);
        for (let i = 1; i <= 5; i++) sse.publish(evt("log", i));
        expect(ids(sse.recent())).toEqual([3, 4, 5]);
    });
});

describe("sse_bus — live fan-out", () => {
    it("onMessage receives every published frame; unsubscribe stops delivery", () => {
        const sse = createSseBus(10);
        const got: SseMessage[] = [];
        const off = sse.onMessage((m) => got.push(m));
        sse.publish(evt("log", 1));
        off();
        sse.publish(evt("log", 2));
        expect(got.map((m) => m.id)).toEqual([1]);
    });

    it("several listeners each get the frame", () => {
        const sse = createSseBus(10);
        const a: SseMessage[] = [];
        const b: SseMessage[] = [];
        sse.onMessage((m) => a.push(m));
        sse.onMessage((m) => b.push(m));
        sse.publish(evt("phase", { sessionId: "s1", phase: "working" }));
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
    });
});

describe("sse_bus — Last-Event-ID replay (docs/04 §Reconnect semantics)", () => {
    it("replay(afterId) returns only newer messages, oldest first; string and numeric forms", () => {
        const sse = createSseBus(10);
        for (let i = 1; i <= 4; i++) sse.publish(evt("log", i));
        expect(ids(sse.replay("2"))).toEqual([3, 4]); // EventSource sends a string
        expect(ids(sse.replay(2))).toEqual([3, 4]);
    });

    it("in-ring replay keeps original ids — re-applied deltas are idempotent", () => {
        const sse = createSseBus(10);
        for (let i = 1; i <= 3; i++) sse.publish(evt("attention", { id: `att-${i}` }));
        const replayed = sse.replay("1");
        expect(replayed.map((m) => m.id)).toEqual([2, 3]);
        expect(replayed.every((m) => m.data.includes("att-"))).toBe(true);
    });

    it("no Last-Event-ID → nothing (first connect gets a fresh snapshot)", () => {
        const sse = createSseBus(10);
        sse.publish(evt("log", 1));
        expect(sse.replay(undefined)).toEqual([]);
    });

    it("garbage Last-Event-ID → nothing (snapshot only)", () => {
        const sse = createSseBus(10);
        sse.publish(evt("log", 1));
        expect(sse.replay("garbage")).toEqual([]);
    });

    it("future id → nothing to replay", () => {
        const sse = createSseBus(10);
        sse.publish(evt("log", 1));
        expect(sse.replay("999")).toEqual([]);
    });

    it("missed-beyond-ring → nothing — snapshot-only degrade (docs/04)", () => {
        const sse = createSseBus(3);
        for (let i = 1; i <= 5; i++) sse.publish(evt("log", i)); // ring: 3,4,5
        // client's last id 1 < 3-1: frame 2 is gone forever → replay unsafe
        expect(ids(sse.replay("1"))).toEqual([]);
        expect(ids(sse.replay("2"))).toEqual([3, 4, 5]); // exactly one behind the gap edge
        expect(ids(sse.replay("3"))).toEqual([4, 5]);
    });
});
