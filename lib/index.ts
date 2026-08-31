// lib/index.ts — public barrel: domain + ports + theme; adapters stay behind
// subpaths (docs/01-architecture.md §Package layout, import matrix line: the
// barrel re-exports domain, ports, and theme and never touches adapters).

// ---- domain ----
export * from "./domain/command";
export * from "./domain/session";
export * from "./domain/attention";
export * from "./domain/summary";
export * from "./domain/filter";

// ---- ports ----
export * from "./ports/status_store";
export * from "./ports/summary_store";
export * from "./ports/attention_store";
export * from "./ports/event_bus";
export * from "./ports/agent_runtime";
export * from "./ports/clock";

// ---- theme ----
export * from "./theme";
