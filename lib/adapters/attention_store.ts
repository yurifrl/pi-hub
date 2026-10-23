// lib/adapters/attention_store.ts — AttentionStore over the StatusStore
// (docs/01 §Package layout: "AttentionStore over the StatusStore"; docs/02
// §attention[]: open items live in status.json, nextAttentionId mints
// att-<n> from the meta counter so ids survive hub restarts). Port
// implementation; all file I/O stays inside the injected StatusStore.
//
// Raise is idempotent per (sessionId, kind) while an item with that pair is
// open: the text is updated in place and the existing id returned (docs/02
// §Attention lifecycle → Raise). Guard 6: items whose sessionId is the hub
// agent's own are rejected with denied. Resolutions stamp resolvedAt (+answer)
// and append the kind:"resolution" line to summaries.jsonl through the
// SummaryStore in the same logical step (docs/02 §summaries.jsonl).

import { hubError } from "../domain/command";
import type { HubError, Result, Caller } from "../domain/command";
import type { AttentionItem } from "../domain/session";
import type { AttentionCandidate } from "../domain/attention";
import { resolutionLine } from "../domain/summary";
import { matchesAttention } from "../domain/filter";
import type { Filter } from "../domain/filter";
import type { AttentionStore } from "../ports/attention_store";
import type { StatusStore } from "../ports/status_store";
import type { SummaryStore } from "../ports/summary_store";
import type { EventBus } from "../ports/event_bus";
import type { Clock } from "../ports/clock";

export type StatusAttentionStoreOptions = {
    status: StatusStore;
    summaries: SummaryStore;
    clock: Clock;
    /** guard 6: session ids that may never raise attention (the hub agent itself) */
    selfIds?: () => string[];
    /** when present, every committed raise/resolve publishes a bus
     * `attention` event (docs/02 §Event frames) — the store stays bus-free
     * otherwise, so standalone compositions keep their current shape. */
    bus?: EventBus;
};

const denied = (message: string): HubError => hubError("denied", message, { retryable: false });

/** AttentionStore over the StatusStore + SummaryStore pair. All mutations are
 * single atomic status.json rewrites; resolutions also append the permanent
 * summaries.jsonl line. Nothing throws — failures are error Results. */
export const createStatusAttentionStore = (opts: StatusAttentionStoreOptions): AttentionStore => ({
    list(f?: Filter): Result<AttentionItem[], HubError> {
        // list is synchronous per the port; read from the last known state via
        // a synchronous snapshot is impossible on a promise port, so list()
        // caches: raise/resolve keep `cache` fresh and an initial read() warms it.
        return filterCached(f);
    },

    async raise(c: AttentionCandidate): Promise<Result<AttentionItem, HubError>> {
        if ((opts.selfIds?.() ?? []).includes(c.sessionId)) {
            return { ok: false, error: denied("attention items cannot be raised for the hub agent itself") };
        }
        const res = await opts.status.update((s) => {
            const existing = s.attention.find((i) => i.resolvedAt === undefined && i.sessionId === c.sessionId && i.kind === c.kind);
            if (existing) {
                existing.text = c.text;
                return s; // idempotent: text updated in place, id unchanged
            }
            const item: AttentionItem = {
                id: `att-${s.nextAttentionId}`,
                sessionId: c.sessionId,
                kind: c.kind,
                text: c.text,
                createdAt: iso(opts.clock),
            };
            s.nextAttentionId += 1;
            s.attention = [...s.attention, item];
            return s;
        });
        if (!res.ok) return res;
        cache = res.value.attention;
        const item = res.value.attention.find((i) => i.sessionId === c.sessionId && i.kind === c.kind && i.resolvedAt === undefined);
        if (item) {
            // committed raise (fresh or idempotent text update) fans out on the
            // bus (docs/01 stage 4): payload is the touched item after the change
            opts.bus?.publish({ topic: "attention", payload: item });
            return { ok: true, value: item };
        }
        return { ok: false, error: denied("raise did not land") };
    },

    async resolve(id: string, answer: string | undefined, by: Caller): Promise<Result<AttentionItem, HubError>> {
        let resolved: AttentionItem | undefined;
        const res = await opts.status.update((s) => {
            const item = s.attention.find((i) => i.id === id && i.resolvedAt === undefined);
            if (!item) return s;
            const at = iso(opts.clock);
            const done: AttentionItem = { ...item, resolvedAt: at, ...(answer !== undefined ? { answer } : {}) };
            resolved = done;
            return {
                ...s,
                attention: s.attention.map((i) => (i.id === id ? done : i)),
            };
        });
        if (!res.ok) return res;
        cache = res.value.attention;
        if (!resolved) {
            return { ok: false, error: hubError("unknown-session", `no open attention item ${id}`, { retryable: false }) };
        }
        // the resolution line lands with the resolve (docs/02 §summaries.jsonl)
        const line = resolutionLine({ t: iso(opts.clock), sessionId: resolved.sessionId, id: resolved.id, kind: resolved.kind, answer, by });
        const appended = await opts.summaries.append(line);
        if (!appended.ok) return appended;
        // committed resolution fans out on the bus: payload is the touched
        // item after the change (resolvedAt stamped; widget treats an item
        // with resolvedAt as a removal)
        opts.bus?.publish({ topic: "attention", payload: resolved });
        return { ok: true, value: resolved };
    },
});

// ---- synchronous list cache ----

let cache: AttentionItem[] = [];

const iso = (clock: Clock): string => new Date(clock.now()).toISOString();

const filterCached = (f?: Filter): Result<AttentionItem[], HubError> =>
    ({ ok: true, value: cache.filter((i) => matchesAttention(i, f)) }) as Result<AttentionItem[], HubError>;
