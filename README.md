# pi-hub

Local agent supervision platform. One word names everything: the platform you
install is `pi-hub`, the core library is `@yurifrl/hub`, the nerve is
`hub.sock`, the CLI is `hub`, the web app is the **Hub Console**, the omp tools
are `hub_*`, the data root is `~/.hub/`.

Every surface — terminal board, web console, omp widget — opens on **what
needs you**: `⚠ needs you → ⏳ running → 💤 idle`, with inline answer/assign
inputs. The raw log stays, demoted. The hub agent (optional, default off)
parses all threads, maintains per-session phase + descriptions, writes
summaries, and raises attention items; with it off, surfaces fall back to
mechanical counts and the raw stream.

Anatomy:

- **`hub.sock`** — the nerve. Newline-delimited JSON frames on
  `~/.hub/hub.sock` (override: `OMP_HUB_SOCK`). Reporter events in, cmd/reply
  out; every surface — CLI, web, plugin — resolves it the same way.
- **Hub Console** — web surface (`@yurifrl/hub-web`). Zero-framework Bun
  server rendering `~/.hub/` state as HTML, live over SSE. Attention cards
  with inline answers, running strip, idle-assign, collapsed stream, summary
  rail. Local-only (`127.0.0.1`, default port 4820).
- **`hub` CLI** — terminal surface (`@yurifrl/hub-cli`). Bare `hub` is the
  attention board; subcommands for every verb; `--json`/`--ndjson` machine
  modes; exit codes `0` ok · `1` usage · `2` unavailable-hub · `3` timeout.
- **`hub_*` tools** — nine omp tools registered in every session
  (`hub_list_sessions`, `hub_send_message`, `hub_call_tool`,
  `hub_spawn_worker`, `hub_kill_worker`, `hub_archive`, `hub_attention`,
  `hub_answer`, `hub_assign`), so any agent can operate the hub.
- **Widget** — 8-line omp widget above the editor: attention counts, top
  item + answer hint, session rows, footer.
- **`~/.hub/`** — all data. `status.json` (single-writer, atomic rewrite),
  append-only `logs/<id>.jsonl` + `summaries.jsonl`, immutable
  `archive/YYYY-MM/<id>.json`, `hub.sock`, `config.json`.

## Architecture

Hexagonal (ports & adapters), package-oriented, DRY. Domain types live once
in `lib/domain/` and import nothing; ports declare what the core needs;
adapters do all I/O (filesystem, JSONL, unix socket, SSE, omp subprocesses);
hosts (`cli/`, `web/`, `extensions/hub.ts`) are thin composition roots.
Dependencies point inward only. Theme tokens defined once in `lib/theme.ts`,
rendered as ANSI in the CLI and CSS vars in the web. Full decision record,
import matrix, and package tree: [docs/01-architecture.md](docs/01-architecture.md).

## Quickstart

Prerequisites: [Bun](https://bun.sh), and the `omp` binary on `PATH`
(override with `OMP_BIN`).

```sh
bun install          # workspaces: lib, cli, web; bin → node_modules/.bin/hub
```

1. **Start the hub** — in any omp session with the plugin loaded:
   `/hub-start`. That session becomes the hub: serves `hub.sock`, spawns the
   RPC brain, registers itself in `status.json`, and renders the widget.
   Every other session auto-attaches (reporter runs in each one).
2. **Open the Hub Console** — run `hub web` (foreground server, opens the
   browser): `http://127.0.0.1:4820`.
3. **Drive from the terminal**:

```sh
hub                  # attention board: answer/assign inline, keys ↑↓ ⏎ d a o l q
hub watch            # full-screen console: attention rail + merged live log
hub log [-f] [id]    # raw session stream (reads files; works while hub is down)
hub summaries [id]   # AI summary rail
```

More verbs: `answer`, `assign`, `send`, `tool`, `spawn`, `kill`, `archive`,
`agent`, `web` — `hub --help` for all; global flags `--config`, `--json`,
`--ndjson`, `--no-color`. Stop the hub with `/hub-stop` (open sessions are
kept — shutdown does not archive them).

## Docs

| doc | owns |
| [docs/01-architecture.md](docs/01-architecture.md) | hexagonal core, layers, import matrix, package tree, error model, testing strategy |
| [docs/02-data-contracts.md](docs/02-data-contracts.md) | `status.json`, `logs/*.jsonl`, `summaries.jsonl`, `archive/`, `hub.sock` frames |
| [docs/03-cli.md](docs/03-cli.md) | `hub` CLI: command tree, config, rendering, output policies, exit codes |
| [docs/04-web.md](docs/04-web.md) | Hub Console: routes, SSE contract, pages |
| [docs/05-omp-plugin.md](docs/05-omp-plugin.md) | plugin entry, reporter, `hub_*` tools, widget, commands, env vars, anti-recursion |
| [docs/06-agents-and-skills.md](docs/06-agents-and-skills.md) | hub agent (watcher), `agentSurface` contract, skills, cadence/budgets |

`spec.html` is the rendered integration spec; `PLAN.md` is the index.

## Docs site

`docs-site/` is a small Astro site that renders `docs-site/src/content/docs/*.md`
(the Hermes bridge design lives there) with an index-first card grid and
infinite scroll. One command builds and serves it at `http://127.0.0.1:4321`:

```sh
task docs
```

## Testing

`bun test` per package (root runs all workspaces). Pure domain units,
adapters against temp dirs, one e2e with two fake sessions over a unix
socket. Type-check each workspace with `bun run check`.

## Repo layout

```text
pi-hub/
├── package.json        # @yurifrl/pi-hub — omp plugin root; workspaces lib/cli/web
├── lib/                # @yurifrl/hub — hexagonal core: domain/ ports/ adapters/ theme.ts
├── cli/                # @yurifrl/hub-cli — bin `hub`: bin.ts commands/ render/ screens/
├── web/                # @yurifrl/hub-web — Hub Console: index.ts server.ts routes/
├── extensions/         # omp plugin: reporter + 9 hub_* tools + widget
├── skills/             # hub-ops (operate the hub), hub-watcher (agent loop)
├── agents/             # hub-watcher.md, pending-agent.md
└── docs/               # spec 01–06
```

The plugin entry is registered in the root `package.json` as
`./extensions/hub.ts` via the `pi.extensions` field; `@earendil-works/*` are
optional peers of the root only — `hub` and the web server install and run
without omp.
