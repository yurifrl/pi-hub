// lib/domain/summary.ts — the AI digest rail: summaries.jsonl line vocabulary
// and the resolution-line format the hub process appends when an item resolves.
// Pure types + pure functions; zero imports (docs/02-data-contracts.md §summaries.jsonl).

import type { SummaryKind, SummaryLine } from "./session";

export type { SummaryKind, SummaryLine };

/**
 * Resolution line text format: `resolved <id> (<kind>): <answer>`.
 * For dismissals the answer portion reads `dismissed`; for agent auto-resolves `auto`
 * (docs/02 §Attention lifecycle → Resolve).
 */
export const resolutionText = (id: string, kind: string, answer: string | undefined): string =>
  `resolved ${id} (${kind}): ${answer ?? "dismissed"}`;

/** Build the summaries.jsonl line appended the moment an AttentionItem resolves. */
export const resolutionLine = (args: {
  /** ISO-8601 UTC timestamp from the injected Clock */
  t: string;
  sessionId: string;
  id: string;
  kind: string;
  answer: string | undefined;
  /** the resolver: cli, web, a closing session id, hub-restart, or auto */
  by: string;
}): SummaryLine => ({
  t: args.t,
  sessionId: args.sessionId,
  kind: "resolution",
  text: resolutionText(args.id, args.kind, args.answer),
  by: args.by,
});
