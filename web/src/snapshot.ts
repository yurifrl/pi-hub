// web/src/snapshot.ts — the single full-state shape (docs/04-web.md §SSE
// contract): `GET /api/status` returns exactly this, and the `snapshot` SSE
// event carries the same JSON. Also the session-detail derivation
// (docs/04 §Session detail): open-then-archive lookup over the injected log
// port. Pure derivation; no I/O.

import type { AttentionItem, Phase, StatusFile } from "@yurifrl/hub";
import type { LogViewEntry, SessionDigest, SessionDetail, SnapshotPayload } from "./types";

const openSessions = (status: StatusFile): SessionDigest[] =>
  Object.entries(status.sessions)
    .filter(([, record]) => record.status === "open")
    .map(([id, record]) => ({ id, record }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, record }) => ({ id, session: record }));

const openAttention = (attention: AttentionItem[]): AttentionItem[] =>
  attention.filter((item) => item.resolvedAt === undefined);

/**
 * Sessions grouped by digest phase (docs/04-web.md §Main page 3–4): the
 * running strip paints working/waiting/blocked; idle-assign paints idle.
 */
export const sessionsByPhase = (
  sessions: SessionDigest[],
): { running: SessionDigest[]; idle: SessionDigest[] } => ({
  running: sessions.filter((s) => s.session.phase !== "idle"),
  idle: sessions.filter((s) => s.session.phase === "idle"),
});

export const sessionPhase = (s: SessionDigest): Phase => s.session.phase;

/**
 * Orientation line when the hub agent is off (docs/04-web.md §Main page 1):
 * synthesized counts — "2 need you · 3 running · 1 idle".
 */
export const synthesizedDigest = (attention: AttentionItem[], sessions: SessionDigest[]): string =>
  `${attention.length} need you · ${sessionsByPhase(sessions).running.length} running · ${sessionsByPhase(sessions).idle.length} idle`;

/**
 * Bounded tail cap (docs/04 §Session detail: "bounded tail + `?since=`
 * cursor param for live tailing").
 */
export const LOG_MAX_LINES = 400;

/** On-disk log line (docs/02 ## logs) — the shape the log adapter yields. */
export type DiskLogLine = { t: string; kind: string; text: string; meta?: Record<string, unknown> };

const toViewEntry = (line: DiskLogLine): LogViewEntry => ({
  t: Date.parse(line.t),
  kind: line.kind,
  text: line.text,
  ...(line.meta !== undefined ? { meta: line.meta } : {}),
});

/**
 * `?since=` cursor parse (docs/04 §Session detail: live tailing). Two cursor
 * vocabularies are accepted, compared NUMERICALLY against entry times:
 * - epoch-ms number-strings (`"1756572000000"`) — the detail-page client's
 *   cursor, the same unit as the `log` SSE delta's `entry.t` and the JSON
 *   poll endpoint's `LogViewEntry.t`;
 * - UTC strings (`2026-08-30T14:03:00.000Z`) — the disk `t` shape (docs/02).
 * Returns the epoch-ms floor, `undefined` when no cursor was given, `null`
 * when unparseable (the routes reject that with 400 — an explicit error beats
 * a silent empty/widened set that hides a unit bug).
 */
export const parseSince = (since: string | undefined): number | null | undefined => {
  if (since === undefined) return undefined;
  if (/^\d+$/.test(since)) return Number(since);
  const ms = Date.parse(since);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * `?since=` cursor narrowing + bounded cap + disk→view shape, shared by the
 * open and archived flavors (docs/04 §Session detail: "bounded tail +
 * `?since=` cursor param for live tailing"). Keeps entries strictly newer
 * than the cursor (parseSince vocabulary: epoch-ms or UTC string) so a live
 * tail page never re-reads what it already rendered; an invalid cursor yields
 * the empty set (the routes 400 before this runs — defense in depth).
 */
export const toLogViewEntries = (lines: DiskLogLine[], since?: string): LogViewEntry[] => {
  const floor = parseSince(since);
  if (floor === null) return [];
  return lines
    .filter((l) => floor === undefined || Date.parse(l.t) > floor)
    .slice(-LOG_MAX_LINES)
    .map(toViewEntry);
};

/**
 * Session detail derivation, open flavor (docs/04 §Session detail + §Route
 * rules: open sessions first, then the archive). The log comes through the
 * injected port per request — a bounded tail over the status.json `log`
 * LINK, never inlined into status.json reads. Null → not open; the route
 * then consults the archive port (404 when neither).
 */
export const sessionDetail = async (
  id: string,
  status: StatusFile,
  logs: { tail(id: string, since?: string): Promise<DiskLogLine[]> } | undefined,
  since?: string,
): Promise<SessionDetail | null> => {
  const open = status.sessions[id];
  if (open === undefined || open.status !== "open") return null;
  return { flavor: "open", id, record: open, entries: toLogViewEntries((await logs?.tail(id, since)) ?? [], since) };
};

/** StatusFile → snapshot payload (same shape as the `snapshot` SSE event). */
export const buildSnapshot = (status: StatusFile): SnapshotPayload => {
  const attention = openAttention(status.attention);
  const sessions = openSessions(status);
  return {
    v: status.version,
    agentOn: status.digest !== undefined || status.agentSession !== undefined,
    digest: status.digest ?? synthesizedDigest(attention, sessions),
    ...(status.agentSession !== undefined ? { agentSession: status.agentSession } : {}),
    attention,
    sessions,
  };
};
