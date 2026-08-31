// web/src/snapshot.ts — the single full-state shape (docs/04-web.md §SSE
// contract): `GET /api/status` returns exactly this, and the `snapshot` SSE
// event carries the same JSON. Pure derivation from StatusFile; no I/O.

import type { AttentionItem, StatusFile } from "@yurifrl/hub";
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
 * Orientation line when the hub agent is off (docs/04-web.md §Main page 1):
 * synthesized counts — "2 need you · 3 running · 1 idle".
 */
export const synthesizedDigest = (attention: AttentionItem[], sessions: SessionDigest[]): string => {
  const running = sessions.filter((s) => s.session.phase !== "idle").length;
  const idle = sessions.filter((s) => s.session.phase === "idle").length;
  return `${attention.length} need you · ${running} running · ${idle} idle`;
};

/** StatusFile → snapshot payload (same shape as the `snapshot` SSE event). */
export const buildSnapshot = (status: StatusFile): SnapshotPayload => {
  const attention = openAttention(status.attention);
  const sessions = openSessions(status);
  return {
    v: status.version,
    digest: status.digest ?? synthesizedDigest(attention, sessions),
    attention,
    sessions,
  };
};
