// lib/adapters/sse_bus.ts — EventBus → SSE stream for the Hub Console (docs/04-web.md):
// one adapter turning published HubEvents into `text/event-stream` chunks with
// Last-Event-ID replay. Port implementation; all I/O; imports ports + domain
// (docs/01-architecture.md §Package layout).

import type { HubEvent } from "../domain/session";
import type { EventBus } from "../ports/event_bus";

/** One SSE message as served to the browser: id for Last-Event-ID, event name,
 * JSON payload. The web host writes these verbatim into the response. */
export type SseMessage = {
    /** monotonically increasing per-bus sequence (the SSE `id:` line) */
    id: number;
    event: string;
    data: string;
};

/** Render one HubEvent as the body of an SSE message. Event name = topic;
 * payload = JSON. Pure. */
export const renderSseMessage = (id: number, evt: HubEvent): SseMessage => ({
    id,
    event: evt.topic,
    data: JSON.stringify(evt.payload),
});

/** The standard wire form (docs/04): `id:` + `event:` + `data:` + blank line. */
export const formatSse = (m: SseMessage): string =>
    `id: ${m.id}\nevent: ${m.event}\ndata: ${m.data}\n\n`;

/**
 * SseBus: subscribes to the EventBus, numbers every event with a monotonic id
 * (a fixed-size ring — old ids are forgotten, matching docs/04's "small ring
 * of recent event ids"), and serves two concerns to the web host:
 *
 *  - `stream()`: a ReadableStream of SSE-formatted chunks for live events.
 *  - `replay(lastEventId)`: the ring contents after `lastEventId` (no sleeps —
 *    pure iteration; docs/01 §Testing: "SSE asserted through event replay, not
 *    sleeps"), then the caller continues with live `stream()` chunks.
 *
 * Dropped-beyond-ring reattach degrades to a snapshot refresh by the host —
 * the snapshot is the contract, deltas are an optimization (docs/04).
 */
export const createSseBus = (bus: EventBus, ringSize = 256) => {
    let nextId = 1;
    // ring of SSE messages in id order, oldest dropped at cap
    const ring: SseMessage[] = [];

    /** Live streams + callback listeners, tracked so publish can fan out and so
     * a dead consumer is pruned on first enqueue error. Declared before the
     * subscription so the callback closes over settled bindings. */
    const streams = new Set<LiveStream>();
    const listeners = new Set<(msg: SseMessage) => void>();

    bus.subscribe((evt) => {
        const msg = renderSseMessage(nextId++, evt);
        ring.push(msg);
        if (ring.length > ringSize) ring.shift();
        for (const out of streams) {
            try {
                out.controller.enqueue(formatSse(msg));
            } catch {
                // consumer gone; its stream is closed/closing — drop the frame
                streams.delete(out);
            }
        }
        for (const fn of listeners) fn(msg);
    });

    /** A live SSE stream: ReadableStream + its controller, tracked so publish
     * can fan out and so a dead consumer is pruned on first enqueue error. */
    type LiveStream = {
        stream: ReadableStream<string>;
        controller: ReadableStreamDefaultController<Uint8Array | string>;
    };

    /** Open a live stream of SSE chunks. It stays open until cancelled; the
     * host closes/cancels it on client disconnect. */
    const stream = (): ReadableStream<string> => {
        const live: LiveStream = {
            stream: null as unknown as ReadableStream<string>,
            controller: null as unknown as ReadableStreamDefaultController<Uint8Array | string>,
        };
        const rs = new ReadableStream<string>({
            start(controller) {
                live.controller = controller;
                streams.add(live);
            },
            cancel() {
                streams.delete(live);
            },
        });
        live.stream = rs;
        return rs;
    };

    /** Alternative fanout for hosts that prefer callback delivery (e.g. Bun's
     * manual chunk writing). Returns unsubscribe. */
    const onMessage = (fn: (msg: SseMessage) => void): (() => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    };

    /** Replay events newer than `lastEventId` from the ring, oldest first, as
     * ready-to-write SSE strings. Unknown/too-old id → whole ring (the host
     * then refreshes with a snapshot). No sleeps; replay is synchronous. */
    const replay = (lastEventId?: string | number): SseMessage[] => {
        const from = typeof lastEventId === "string" ? Number.parseInt(lastEventId, 10) : lastEventId;
        if (from === undefined || Number.isNaN(from)) return [...ring];
        return ring.filter((m) => m.id > from);
    };

    return { stream, onMessage, replay };
};

export type SseBus = ReturnType<typeof createSseBus>;
