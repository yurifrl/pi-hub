// web/src/index.ts — public barrel of @yurifrl/hub-web: one entry, startHubWeb
// (docs/04-web.md §Server). Types ship alongside for host composition roots.

export { startHubWeb, DEFAULT_WEB_PORT } from "./server";
export type { HubWebDeps, HubWebLogs, HubWebTheme, SessionDigest, SnapshotPayload, SseConn } from "./types";
export { buildSnapshot, synthesizedDigest } from "./snapshot";
