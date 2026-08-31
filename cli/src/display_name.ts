// cli/src/display_name.ts — session display name (docs/03-cli.md §bin:
// "Session display name = worker `name` if present, else the first 8 chars
// of sessionId").

/**
 * Display name for a session from a `list` reply sessions map. Falls back to
 * the id prefix when the session is not in the map (e.g. it closed mid-flight).
 */
export const displayName = (id: string, sessions: Record<string, Record<string, unknown>>): string => {
  const rec = sessions[id];
  if (rec !== undefined) {
    const name = rec.name ?? rec.workerName;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return id.slice(0, 8);
};
