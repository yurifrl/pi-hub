# unlazy spec — implementation spec for pi-hub

Deliverable: a complete, implementation-grade specification for pi-hub rendered as `spec.html` with backing markdown docs, built via parallel subagents under unlazy gates.

## Contract (revision 1)

| id | requirement | owner | gate |
|---|---|---|---|
| C1 | `docs/01-architecture.md` — hexagonal + package-oriented + DRY architecture ADR with full tree + import rules + core abstractions + error model + testing | ArchDoc | G1 |
| C2 | `docs/02-data-contracts.md` — status.json schema, logs/summaries jsonl, archive, hub.sock protocol, attention lifecycle, migration | DataDoc | G2 |
| C3 | `docs/03-cli.md` — CLI spec: bin, board, all subcommands, ANSI rendering, output policies, ASCII sketches | CliDoc | G3 |
| C4 | `docs/04-web.md` — Hub Console spec: routes, SSE contract, wireframes, security | WebDoc | G3? -> G4 |
| C5 | `docs/05-omp-plugin.md` — plugin ADR: entry, reporter, 9 tools, widget, agent spawn, shutdown | PluginDoc | G5 |
| C6 | `docs/06-agents-and-skills.md` — hub agent loop, surface contract, skills/, agents/, flows | AgentSkillDoc | G6 |
| C7 | `spec.html` — single rendered implementation spec linking/embedding all docs | driver | G7 |
| C8 | `PLAN.md` re-indexed to spec (architecture, DRY, structures, filesystem, skills, agents, implementation detail) | driver | G8 |
| C9 | Cross-doc consistency (names, ports, tools, paths) | driver | G9 |

## Leaves (parallel wave 1, disjoint OWNS)

- leaf-arch   OWNS: pi-extentions/pi-hub/docs/01-architecture.md           -> G1
- leaf-data   OWNS: pi-extentions/pi-hub/docs/02-data-contracts.md          -> G2
- leaf-cli    OWNS: pi-extentions/pi-hub/docs/03-cli.md                     -> G3
- leaf-web    OWNS: pi-extentions/pi-hub/docs/04-web.md                     -> G4
- leaf-plugin OWNS: pi-extentions/pi-hub/docs/05-omp-plugin.md              -> G5
- leaf-agents OWNS: pi-extentions/pi-hub/docs/06-agents-and-skills.md       -> G6

Shared, written by driver (no leaf owns these): scripts under
`pi-extentions/pi-hub/.unlazy/spec/scripts/`, `spec.html`, `PLAN.md`, `GATES.md`.

## Verification scripts

Driver-owned Node checkers in `pi-hub/.unlazy/spec/scripts/`:
- `check-doc.mjs <id>` — asserts doc exists, >5KB dense content, has all required section headers for that module, contains the required contract tokens (package/port/tool names), and contains no fenced JS implementation code (types allowed).
- `check-spec-html.mjs` — spec.html exists, contains all six doc sections rendered inline + links, passes tag-balance check.
- `check-plan-index.mjs` — PLAN.md references each doc, states DRY, hexagonal, filesystem layout, skills, agents.
- `check-consistency.mjs` — greps all docs for contract tokens and reports agreement (exact names appear in expected docs; no contradicting port names).

## States

- leaf-arch: READY
- leaf-data: READY
- leaf-cli: READY
- leaf-web: READY
- leaf-plugin: READY
- leaf-agents: READY
- node-integration (branch): WAITING on all leaves -> spec.html + PLAN.md + consistency (G7,G8,G9)
