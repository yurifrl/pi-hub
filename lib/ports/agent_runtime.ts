// lib/ports/agent_runtime.ts — AgentRuntime: spawn/send/kill omp agent sessions.
// Imports domain only (docs/01-architecture.md §Core abstractions ports).
// Hub-side handle for a driven omp child (`omp --mode rpc` worker or `--mode acp`
// agent) — the plugin's promptAndWait/dispose surface hangs off it (docs/05).

import type { Result, HubError } from "../domain/command";

/** A live driven child process. `sessionId` is assigned once the child reports session_start. */
export type AgentHandle = {
  /** worker name (default worker-N) or the agent's name */
  name: string;
  /** omp session id once reported; null until the child announces */
  sessionId: string | null;
  model?: string;
};

export type AgentRuntime = {
  spawn(spec: { name?: string; model?: string }): Promise<Result<AgentHandle, HubError>>;
  send(name: string, text: string): Promise<Result<void, HubError>>;
  kill(name: string): Promise<Result<void, HubError>>;
};
