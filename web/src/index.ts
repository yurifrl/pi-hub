// web/src/index.ts — public barrel of @yurifrl/hub-web: one entry, startHubWeb
// (docs/04-web.md §Server). Types ship alongside for host composition roots.

export { startHubWeb, DEFAULT_WEB_PORT } from "./server";
export {
  DEFAULT_AGENT_NAME,
  archiveIndex,
  resolveAgentPage,
  resolveDetail,
  resolveSurface,
} from "./detail";
export type { AgentPageInfo, HubArchiveEntry, HubArchiveRecord, HubWebArchive, HubWebDeps, HubWebLogs, HubWebSurfaces, HubWebTheme, LogLine, LogViewEntry, SessionDetail, SessionDigest, SnapshotPayload, SseConn, SurfaceSection, SurfaceState } from "./types";
export { buildSnapshot, parseSince, sessionDetail, toLogViewEntries, synthesizedDigest, LOG_MAX_LINES } from "./snapshot";
