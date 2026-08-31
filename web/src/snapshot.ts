// web/src/snapshot.ts — the single full-state shape (docs/04-web.md §SSE
// contract): `GET /api/status` returns exactly this, and the `snapshot` SSE
// event carries the same JSON. Pure derivation from StatusFile; no I/O.

import type { AttentionItem, Phase, StatusFile } from "@yurifrl/hub";
import type { SessionDigest, SnapshotPayload } from "./types";

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

/** StatusFile → snapshot payload (same shape as the `snapshot` SSE event). */
export const buildSnapshot = (status: StatusFile): SnapshotPayload => {
  const attention = openAttention(status.attention);
  const sessions = openSessions(status);
  return {
    v: status.version,
    agentOn: status.digest !== undefined || status.agentSession !== undefined,
    digest: status.digest ?? synthesizedDigest(attention, sessions),
    attention,
    sessions,
  };
};
