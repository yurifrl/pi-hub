// cli/src/agent_surface_types.ts — the minimal surface.json seed shape the CLI
// writes (docs/06 §agentSurface contract). Deliberately local: cli may not
// import web (docs/01 §Import matrix), the domain never owned this file shape
// (the agent owns it at runtime), and the seed uses only the required fields.

export type AgentSurfaceSeed = {
  agent: string;
  surface: string;
  revision: number;
  updatedAt: string;
};
