// cli/src/log_entry.ts — the one boundary where raw log lines become LogEntry.
// Disk lines (docs/02 §logs: `t` UTC string, kinds prompt|tool|result|think|
// message|system) and EventBus frames (`t` epoch ms, raw omp frame kinds) both
// land here, so every painter sees `t: number` and a raw-frame `kind`.

import type { LogEntry } from "@yurifrl/hub";

type RawKind = LogEntry["kind"];

/** log kind (raw frame or disk vocabulary) → raw frame kind. Disk side is the
 * inverse of hub_core's LOG_KIND, lossy for `system`. */
const KIND: Record<string, RawKind> = {
  session_start: "session_start",
  user_message: "user_message",
  assistant_message: "assistant_message",
  tool_call: "tool_call",
  agent_end: "agent_end",
  prompt: "user_message",
  message: "assistant_message",
  think: "assistant_message",
  tool: "tool_call",
  result: "tool_call",
  system: "session_start",
};

/** One parsed JSON value → LogEntry, or null when it is not a log line. */
export const normalizeLogEntry = (v: unknown): LogEntry | null => {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  const kind = KIND[r.kind];
  if (kind === undefined) return null;
  const parsed = typeof r.t === "number" ? r.t : typeof r.t === "string" ? Date.parse(r.t) : Number.NaN;
  return {
    t: Number.isFinite(parsed) ? parsed : 0,
    sessionId: typeof r.sessionId === "string" ? r.sessionId : "",
    kind,
    text: typeof r.text === "string" ? r.text : "",
    ...(r.meta !== null && typeof r.meta === "object" ? { meta: r.meta as Record<string, unknown> } : {}),
  };
};

/** JSONL body → entries; blank and corrupt lines are skipped. */
export const parseLogLines = (body: string): LogEntry[] => {
  const out: LogEntry[] = [];
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const e = normalizeLogEntry(v);
    if (e !== null) out.push(e);
  }
  return out;
};
