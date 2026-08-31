// lib/adapters/sse_bus.ts — SSE transport for the Hub Console stream
// (docs/04-web.md §SSE contract). The bus numbers published HubEvents with a
// monotonic id, keeps a small ring of recent deltas, and fans frames out to
// the host; the host (web server) owns HTTP, snapshots, and connection
// lifecycle. Port implementation; imports ports + domain only (docs/01
// §Package layout: no theme, no store access here — hue and snapshot
// translation are presentation concerns of the web host).
//
// Reconnect contract (docs/04): the host answers a `Last-Event-ID` reattach
// with the ring replay followed by a fresh snapshot; a reattach that missed
// more than the ring degrades to snapshot only — the snapshot is the
// contract, deltas are an optimization. Snapshot events are unnumbered (no
// `id:` line): the client's Last-Event-ID never moves onto a snapshot, so
// replaying deltas stays idempotent and a snapshot is never re-delivered.

import type { HubEvent } from "../domain/session";

/** One SSE frame as served to the browser: event name + JSON payload, plus
 * the `id:` line for deltas (absent for snapshots). */
export type SseMessage = {
    /** monotonically increasing per-bus sequence (the SSE `id:` line); snapshots carry none */
    id?: number;
    event: string;
    data: string;
};

/** The bus contract consumed by the web host (docs/04 §SSE contract):
 * numbered deltas, ring replay, live fan-out. */
export interface SseBus {
    /** Number a published event, ring it, fan it out; returns the frame. */
    publish(evt: HubEvent): SseMessage;
    /** Register a live-delivery listener; returns unsubscribe. */
    onMessage(fn: (msg: SseMessage) => void): () => void;
    /** Frames newer than lastEventId, oldest first; [] degrades to snapshot. */
    replay(lastEventId?: string | number): SseMessage[];
    /** Ring contents oldest-first — diagnostics and tests. */
    recent(): SseMessage[];
}

/** Render one HubEvent as the body of an SSE delta frame. Event name = topic;
 * payload = JSON. Pure. */
export const renderSseMessage = (id: number, evt: HubEvent): SseMessage => ({
    id,
    event: evt.topic,
    data: JSON.stringify(evt.payload),
});

/** The standard wire form (docs/04): `id:` (deltas only) + `event:` + `data:`
 * + blank line. */
export const formatSse = (m: SseMessage): string =>
    (m.id === undefined ? "" : `id: ${m.id}\n`) + `event: ${m.event}\ndata: ${m.data}\n\n`;

/**
 * SseBus: the delta side of `GET /stream`. The host publishes committed hub
 * events; the bus numbers them, rings them, and fans frames out to
 * registered listeners (one per open SSE connection). Replay is synchronous
 * iteration over the ring — no sleeps (docs/01 §Testing: "SSE asserted
 * through event replay, not sleeps").
 */
export const createSseBus = (ringSize = 256) => {

    let nextId = 1;
    // ring of numbered delta frames in id order, oldest dropped at cap
    const ring: SseMessage[] = [];
    const listeners = new Set<(msg: SseMessage) => void>();

    /** Number a published event, ring it, fan it out. Event name = topic;
     * payload = JSON. Returns the frame the listeners received. */
    const publish = (evt: HubEvent): SseMessage => {
        const msg = renderSseMessage(nextId++, evt);
        ring.push(msg);
        if (ring.length > ringSize) ring.shift();
        for (const fn of listeners) fn(msg);
        return msg;
    };

    /** Register a live-delivery listener (one per open SSE connection).
     * Returns unsubscribe. */
    const onMessage = (fn: (msg: SseMessage) => void): (() => void) => {
        listeners.add(fn);
        return () => {
            listeners.delete(fn);
        };
    };

    /** The ring's current contents, oldest first — host-side diagnostics and
     * tests. Does not decide replayability; replay() does that. */
    const recent = (): SseMessage[] => [...ring];

    /**
     * Frames newer than `lastEventId` from the ring, oldest first.
     *
     * Returns `[]` — and the host responds with a snapshot only — when the
     * reattach cannot be served from the ring: no id, garbage, an id at or
     * past the newest frame, or an id older than the ring's oldest retained
     * predecessor (missed-beyond-ring; docs/04 §Reconnect semantics). Gap
     * detection: when frames were dropped, the oldest retained frame's id is
     * the first frame the bus still holds, so a client whose last id is below
     * `oldest - 1` missed at least one frame that is gone.
     */
    const replay = (lastEventId?: string | number): SseMessage[] => {
        const from = typeof lastEventId === "string" ? Number.parseInt(lastEventId, 10) : lastEventId;
        if (from === undefined || Number.isNaN(from) || ring.length === 0) return [];
        const oldest = ring[0]!.id!;
        if (from < oldest - 1) return []; // missed-beyond-ring → snapshot only
        return ring.filter((m) => m.id! > from);
    };

    return { publish, onMessage, replay, recent };
};