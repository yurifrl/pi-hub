// lib/adapters/event_frames.ts — HubEvent (bus) → hub.sock event frame (docs/02 §Event frames).
// Pure: the hub subscribes the bus to the socket's broadcast through this mapper,
// so every committed change reaches subscribed clients without polling.

import type { HubEvent } from "../domain/session";
import { PROTOCOL_VERSION } from "./unix_socket";

export type EventFrame = { v: typeof PROTOCOL_VERSION; ch: "event"; kind: string } & Record<string, unknown>;

const frame = (kind: string, body: Record<string, unknown>): EventFrame => ({ v: PROTOCOL_VERSION, ch: "event", kind, ...body });

/** Bus event → frame; payloads that do not match their topic yield null. */
export const hubEventToFrame = (evt: HubEvent): EventFrame | null => {
  if (evt.payload === null || typeof evt.payload !== "object") return null;
  const p = evt.payload as Record<string, unknown>;
  switch (evt.topic) {
    case "log": {
      if (typeof p.kind !== "string" || typeof p.sessionId !== "string") return null;
      const { kind, ...rest } = p;
      return frame(kind, rest);
    }
    case "attention":
      return frame("attention", { item: p });
    case "phase":
      return frame("phase", p);
    case "summary":
      return frame("summary", p);
    case "status": {
      // archive = the session closed: clients drop the row (docs/02 `closed` frame)
      if (p.kind === "archive" && typeof p.id === "string") return frame("closed", { sessionId: p.id, path: p.path });
      const { kind: change, ...rest } = p;
      return frame("status", { change, ...rest });
    }
    default:
      return null;
  }
};
