// lib/adapters/sse_bus.test.ts — Last-Event-ID replay asserted through event
// replay, not sleeps (docs/01 §Testing; docs/04-web.md §stream).
import { describe, expect, it } from "bun:test";
import { createSseBus, formatSse, renderSseMessage } from "./sse_bus";
import type { SseMessage } from "./sse_bus";
import type { HubEvent } from "../domain/session";

/** Minimal EventBus double: capture the subscriber so tests publish directly. */
const makeBus = () => {
    let fn: ((evt: HubEvent) => void) | null = null;
    const bus = {
        publish: (e: HubEvent) => fn?.(e),
        subscribe: (sub: (e: HubEvent) => void) => {
            fn = sub;
            return () => {
                fn = null;
            };
        },
    };
    return { bus };
};

const evt = (topic: HubEvent["topic"], payload: unknown): HubEvent => ({ topic, payload });

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
});

describe("sse_bus — id assignment and ring", () => {
    it("ids are monotonic across published events", () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 10);
        sse.onMessage(() => {});
        bus.publish(evt("log", 1));
        bus.publish(evt("log", 2));
        const msgs = sse.replay();
        expect(msgs.map((m: SseMessage) => m.id)).toEqual([1, 2]);
        expect(msgs.map((m: SseMessage) => m.data)).toEqual(["1", "2"]);
    });

    it("ring cap drops the oldest messages", () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 3);
        sse.onMessage(() => {});
        for (let i = 1; i <= 5; i++) bus.publish(evt("log", i));
        expect(sse.replay().map((m: SseMessage) => m.id)).toEqual([3, 4, 5]);
    });
});

describe("sse_bus — Last-Event-ID replay (docs/04)", () => {
    it("replay(afterId) returns only newer messages, oldest first", () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 10);
        sse.onMessage(() => {});
        for (let i = 1; i <= 4; i++) bus.publish(evt("log", i));
        const replayed = sse.replay("2"); // EventSource sends a string
        expect(replayed.map((m: SseMessage) => m.id)).toEqual([3, 4]);
        expect(sse.replay(2).map((m: SseMessage) => m.id)).toEqual([3, 4]); // numeric form too
    });

    it("unknown / too-old id replays the whole ring (host refreshes with a snapshot)", () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 3);
        sse.onMessage(() => {});
        for (let i = 1; i <= 4; i++) bus.publish(evt("log", i)); // ring: 2,3,4
        expect(sse.replay("1").map((m: SseMessage) => m.id)).toEqual([2, 3, 4]);
        expect(sse.replay("999")).toEqual([]);
        expect(sse.replay("garbage").map((m: SseMessage) => m.id)).toEqual([2, 3, 4]);
        expect(sse.replay(undefined).map((m: SseMessage) => m.id)).toEqual([2, 3, 4]);
    });

    it("replay is synchronous iteration — no sleeps, no async", () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 10);
        sse.onMessage(() => {});
        bus.publish(evt("log", 1));
        const t0 = performance.now();
        sse.replay("0");
        expect(performance.now() - t0).toBeLessThan(50);
    });
});

describe("sse_bus — live streams", () => {
    it("stream() enqueues SSE chunks for every published event; cancel prunes the sink", async () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 10);
        const rs = sse.stream();
        const reader = rs.getReader();
        bus.publish(evt("status", { pid: 1 }));
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value).toBe('id: 1\nevent: status\ndata: {"pid":1}\n\n');
        bus.publish(evt("summary", { text: "s" }));
        const second = await reader.read();
        expect(second.value).toContain("event: summary");
        await reader.cancel();
        // after cancel the sink is pruned: publishing must not throw
        bus.publish(evt("log", "post-cancel"));
    });

    it("onMessage callback fanout: unsubscribe stops delivery", () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 10);
        const got: SseMessage[] = [];
        const off = sse.onMessage((m) => got.push(m));
        bus.publish(evt("log", 1));
        off();
        bus.publish(evt("log", 2));
        expect(got.map((m) => m.id)).toEqual([1]);
    });

    it("events still ring-bucketed while a stream is open — replay works after", async () => {
        const { bus } = makeBus();
        const sse = createSseBus(bus, 10);
        const reader = sse.stream().getReader();
        bus.publish(evt("log", 1));
        bus.publish(evt("log", 2));
        await reader.read();
        await reader.cancel();
        expect(sse.replay("1").map((m: SseMessage) => m.id)).toEqual([2]);
    });
});
