// lib/adapters/timeout_scheduler.ts — Scheduler port over host timers
// (docs/01 §Core abstractions Scheduler: "injected timers; tests run them
// manually"). Port implementation; the only setTimeout in the extension's
// lib-side stack — tests inject a manual Scheduler instead.
import type { Scheduler } from "../ports/scheduler";

export const createTimeoutScheduler = (): Scheduler => ({
    setTimeout(fn, ms) {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
    },
});
