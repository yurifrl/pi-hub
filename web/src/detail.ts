// web/src/detail.ts — session detail + archive + agent view-model assembly
// (docs/04-web.md §Session detail, §Routes /archive*, §Agent page). Composes
// the injected log/archive/surface ports over status.json state; the html
// renderer stays a pure string function. No I/O here — the ports do it.

import type { AttentionItem, SessionRecord, StatusFile, SummaryLine } from "@yurifrl/hub";
import { LOG_MAX_LINES, sessionDetail, toLogViewEntries } from "./snapshot";
import type {
  AgentPageInfo,
  HubArchiveEntry,
  HubWebArchive,
  HubWebDeps,
  HubWebLogs,
  HubWebSurfaces,
  SessionDetail,
  SnapshotPayload,
  SurfaceState,
} from "./types";

/** Default agent name for surface.json lookup (docs/06; lib WATCHER_DEFAULTS). */
export const DEFAULT_AGENT_NAME = "hub-watcher";

/** What a page needs to resolve a session detail, open or archived. */
export type DetailEnv = {
  logs?: HubWebLogs;
  archive?: HubWebArchive;
  surfaces?: HubWebSurfaces;
  /** agent name for ~/.hub/agents/<name>/surface.json; default hub-watcher */
  agentName?: string;
};

/**
 * `/session/:id` + `/archive/:id` resolution (docs/04 §Route rules: open
 * sessions first, then the archive; one renderer, data-driven flavor).
 * `forceArchived` is `/archive/:id` — it 404s (null) for ids that are not
 * archived. Log entries ride along in either flavor (bounded tail, `since`
 * narrowed when given).
 */
export const resolveDetail = async (
  id: string,
  status: StatusFile,
  env: DetailEnv,
  opts: { forceArchived?: boolean; since?: string } = {},
): Promise<SessionDetail | null> => {
  if (opts.forceArchived !== true) {
    const open = await sessionDetail(id, status, env.logs, opts.since);
    if (open !== null) return open;
  }
  const record = await env.archive?.read(id);
  if (record === undefined || record === null) return null;
  return {
    flavor: "archived",
    id,
    record: record.record,
    closedAt: record.closedAt,
    closedBy: record.closedBy,
    finalSummary: record.finalSummary,
    resolutions: record.resolutions,
    entries: toLogViewEntries((await env.logs?.tail(id, opts.since)) ?? [], opts.since),
  };
};

/**
 * `/archive` index (docs/04 §Routes: list archive/YYYY-MM/*.json newest
 * first, no socket reads). The injected archive port owns the ordering.
 */
export const archiveIndex = async (archive: HubWebArchive | undefined): Promise<HubArchiveEntry[]> =>
  (await archive?.list()) ?? [];

/** Agent surface resolution (docs/06 §agentSurface): registry lookup happens
 * in html.ts; this resolves the file-backed state when the record declares a
 * custom (non-watcher) surface. Missing file / parse failure → null → the
 * registry renders the generic card. */
export const resolveSurface = async (
  record: SessionRecord,
  surfaces: HubWebSurfaces | undefined,
  agentName: string,
): Promise<SurfaceState | null> => {
  if (surfaces === undefined || record.agentSurface === undefined || record.agentSurface === "watcher") {
    return null;
  }
  return surfaces.read(agentName);
};

/** `/agent` view-model: the hub agent's live record + watcher panel data
 * (docs/04 §Agent page). Null → the empty-state page. */
export const resolveAgentPage = (
  snapshot: SnapshotPayload,
  summaries: SummaryLine[],
  agentSessionId: string | undefined,
): AgentPageInfo | null => {
  if (agentSessionId === undefined) return null;
  const found = snapshot.sessions.find((s) => s.id === agentSessionId);
  if (found === undefined) return null;
  const counts: Record<AttentionItem["kind"], number> = { approval: 0, question: 0, blocked: 0, idle: 0 };
  for (const item of snapshot.attention) {
    if (item.kind in counts) counts[item.kind]! += 1;
  }
  const lastSummary = summaries.filter((s) => s.sessionId === agentSessionId).at(0) ?? null;
  return { sessionId: agentSessionId, record: found.session, digest: snapshot.digest, counts, lastSummary };
};

/** Deps → DetailEnv: narrow the optional port bundle the routes need. */
export const detailEnvFrom = (deps: HubWebDeps): DetailEnv => ({
  ...(deps.logs !== undefined ? { logs: deps.logs } : {}),
  ...(deps.archive !== undefined ? { archive: deps.archive } : {}),
  ...(deps.surfaces !== undefined ? { surfaces: deps.surfaces } : {}),
  ...(deps.agentName !== undefined ? { agentName: deps.agentName } : {}),
});

/** Re-export so routes/html need only one import for detail plumbing. */
export { LOG_MAX_LINES, sessionDetail };
