// lib/ports/event_bus.ts — EventBus: publish/subscribe hub events.
// Imports domain only (docs/01-architecture.md §Core abstractions ports).

import type { HubEvent } from "../domain/session";

export type EventBus = {
  publish(evt: HubEvent): void;
  /** returns unsubscribe */
  subscribe(fn: (evt: HubEvent) => void): () => void;
};
