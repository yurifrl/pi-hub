# pi-hub — Implementation Plan

> Status: **spec complete**. This file is the index; the implementation-grade
> specification lives in `docs/` (six modules) and `spec.html` (rendered
> integration, open in a browser). No code exists yet — by design this is the
> plan the implementation will follow.

One word, normalized everywhere: **hub**. `pi-hub` is the platform you install,
`@yurifrl/hub` is the core lib, `hub.sock` is its nerve, `hub` is the CLI, the
web app is the **Hub Console**, `hub_*` are its tools, `~/.hub/` is its data.

## 0. The stance: action-oriented, agent-mediated

Every surface — terminal board, web console, omp widget — opens **telling you
what needs attention**. The hub agent parses all threads and raises elements
you answer in place:

```
orientation line   "⚠ tilt needs approval · deploy canary 2/3 · docs idle 12m"
⚠ NEEDS YOU        approvals + questions → inline answer box, type + ⏎
⏳ RUNNING          one digest line per active session
💤 IDLE            sessions waiting for work → "assign:" input right there
      … raw log stream one keypress / one click away (kept, demoted)
```

## 1. Architecture (docs/01-architecture.md)

hexagonal (ports & adapters), package-oriented, DRY. Full decision record,
import matrix, package tree, core abstractions (`CommandSurface`,
`SurfaceRenderer`, event normalize pipeline, `Result`/error taxonomy), testing
strategy, and repo conventions: **docs/01-architecture.md**.

- Dependency direction points inward: adapters → ports → domain; domain imports nothing.
- DRY: every type defined once in `lib/domain/`; theme tokens once in `lib/theme.ts`; sanctioned cross-package duplications listed with why.
- Packages: `@yurifrl/pi-hub` (root, omp plugin) · `@yurifrl/hub` (lib) · `@yurifrl/hub-cli` (bin `hub`) · `@yurifrl/hub-web`.

```
pi-hub/
├── package.json          # @yurifrl/pi-hub — workspaces lib/cli/web, peerDeps @earendil-works/* optional
├── lib/                  # @yurifrl/hub — domain/ ports/ adapters/ theme.ts index.ts
├── cli/                  # @yurifrl/hub-cli — bin.ts commands/ render/ screens/
├── web/                  # @yurifrl/hub-web — index.ts server.ts routes/
├── extensions/hub.ts     # omp plugin: reporter + tools + widget (driving adapter)
├── skills/               # hub-ops, hub-watcher (SKILL.md each)
├── agents/               # hub-watcher.md, pending-agent.md
└── docs/                 # this spec
```

### tk-sne verification

Root manifest contract verified against docs/01-architecture.md lines 130-148:
name @yurifrl/pi-hub, private true, workspaces [lib, cli, web], optional
peerDependencies @earendil-works/pi-coding-agent + @earendil-works/pi-tui with
peerDependenciesMeta optional — all present. Committed as 18ae03b on
matchday/tk-sne; extra "type": "module" matches the reference
pi-fbr-match-day/package.json and is additive, not a deviation.

## 2. Data contracts (docs/02-data-contracts.md)

Schemas + lifecycle for everything `~/.hub/` and `hub.sock`: **docs/02-data-contracts.md**

- **`~/.hub/status.json`** — one object; `sessions` map keyed by sessionId (status/kind/cwd/title/model/description/phase/log link/toolCounts/turns); top-level `attention[]` (`AttentionItem { id, sessionId, kind: approval|question|blocked|idle, text, createdAt, resolvedAt?, answer? }`); `archived[]` links. Sessions stay **open** until properly closed → removed to `archive/YYYY-MM/<id>.json` with `closedAt` + `finalSummary`. `log` is a link, never content. Single-writer (hub process only), atomic tmp+rename, versioned.
- **`~/.hub/logs/<id>.jsonl`** — append-only event lines `{t, sessionId, kind, text, meta?}`.
- **`~/.hub/summaries.jsonl`** — append-only `{t, sessionId, kind: summary|resolution, text, by}`.
- **`hub.sock`** — newline-delimited JSON frames; reporter frames (session_start w/ `attached` flag, user_message, assistant_message, tool_call, agent_end); cmd/reply with cmdId correlation; version handshake.

## 3. Surfaces

| surface | spec | main view |
|---|---|---|
| CLI `hub` | **docs/03-cli.md** | bare `hub` = attention board (inline answer/assign inputs, keys `↑↓` type-to-answer `d` `a` `o` `l` `q`); subcommands: answer, assign, log, summaries, send, tool, spawn, kill, archive, watch, agent, web; `--json`/`--ndjson`/human; exit codes 0/1/2/3 |
| Web Console | **docs/04-web.md** | attention console: orientation line, attention cards with inline inputs, running strip, idle-assign, collapsed stream, summary rail; SSE (`/stream`, snapshot/attention/log/summary/phase events); routes + `/api/answer|assign|send|dismiss`; 127.0.0.1 local-only v1 |
| omp plugin | **docs/05-omp-plugin.md** | 8-line widget above the editor: `⚠ n ⏳ n 💤 n` + top attention item + answer hint; reporter in every session (attach-on-connect); 9 `hub_*` tools; `/hub-start` `/hub-stop` `/hub-agent` |

## 4. Agents & skills (docs/06-agents-and-skills.md)

The hub's own agent (optional, default off) is **the thing that builds the main
view**: subscribes to the EventBus, maintains per-session `phase`
(working|waiting|idle|blocked) + `description`, writes `summaries.jsonl`,
raises/resolves `attention[]`. Surfaces render this contract; custom
`agentSurface` interfaces (watcher default, pending demo) are the agent's
choice, state via `~/.hub/agents/<name>/surface.json`.

- Skills: `skills/hub-ops/SKILL.md` (any agent using hub_* tools), `skills/hub-watcher/SKILL.md` (classification rubric + summary style).
- Agent files: `agents/hub-watcher.md`, `agents/pending-agent.md` (match-day pattern).
- Cadence/budgets: debounce per agent_end, ≤1 summary/turn ≤2 sentences, idempotent resolutions.

## 5. Theme (defined once, rendered twice)

| token | hex | semantics |
|---|---|---|
| accent | `#70e1c4` | chrome, selection, cursor, send |
| ok | `#3fd68f` | open, ✓, `●` live |
| warn | `#f5c04e` | attention, waiting, summaries |
| err | `#ff7a9a` | failures, kill confirm |
| muted | `#8b97b0` | timestamps, ids, hints |
| session-hue | hash per session | left bar tracking a session in any stream |

lib/theme.ts owns tokens; CLI maps → ANSI, web → CSS vars.

## 6. Implementation detail pointers

- **Structures**: domain types (session.ts, attention.ts, summary.ts, filter.ts, command.ts), ports (StatusStore, SummaryStore, AttentionStore, EventBus, AgentRuntime, Clock), adapters (json_store, jsonl_store, omp_agent, unix_socket, sse_bus) — §Core abstractions in docs/01.
- **Filesystem organization**: full per-directory tree + import matrix — docs/01 §Package layout, §Module boundaries.
- **File system data layout**: `~/.hub/` file schemas — docs/02.
- **CLI rendering stack**: hand-rolled screen buffer (`screen.ts board.ts stream.ts inputs.ts`), raw-mode keypress, TTY degradation — docs/03 §Rendering.
- **SSE + client state**: event table, Last-Event-ID reconnect — docs/04 §SSE contract, §Client state.
- **Plugin lifecycle**: entry guard, reporter events, attach-on-connect, shutdown semantics (hub shutdown does NOT archive open sessions) — docs/05.
- **Error model**: `Result<T,E>`, taxonomy unavailable-hub | unknown-session | timeout | denied, no throws across ports — docs/01 §Error model.
- **Testing**: bun test per package, pure domain units, adapters vs temp dirs, one e2e with two fake sessions over a unix socket — docs/01 §Testing.

## 7. Verification

Machine-checked ledger: `.unlazy/spec/GATES.md` (9 gates — six doc modules,
spec.html, PLAN.md index, cross-doc contract consistency). Evidence recorded
per gate; reverify with
`node ~/.omp/agent/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --approve .unlazy/spec/GATES.md`.

## 8. Non-goals for the spec phase

No implementation code, no CI, no migration of the existing
`home/.omp/agent/extensions/hub.ts` (that code is prior art feeding 05-omp-plugin).
