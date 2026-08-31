// lib/adapters/memory_bus.ts — EventBus over in-process pub/sub (docs/01
// §Core abstractions EventBus). Port implementation; no I/O. The hub
// composition root uses one bus for the whole process: reporter frames and
// cmd/reply completions publish onto it, the watcher runtime and socket
// event fan-out subscribe to it.
import type { EventBus } from "../ports/event_bus";
import type { HubEvent } from "../domain/session";

/** In-memory EventBus: synchronous fan-out in subscription order. A throwing
 * subscriber is isolated — publish never propagates subscriber failures. */
export const createMemoryBus = (): EventBus => {
    const subscribers = new Set<(evt: HubEvent) => void>();

    return {
        publish(evt) {
            for (const fn of subscribers) {
                try {
                    fn(evt);
                } catch {
                    // a broken listener must not break the publisher
                }
            }
        },
        subscribe(fn) {
            subscribers.add(fn);
            return () => {
                subscribers.delete(fn);
            };
        },
    };
};
