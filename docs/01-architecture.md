# pi-hub — Architecture

Scope: the hexagonal core (`@yurifrl/hub`), the host packages (`@yurifrl/hub-cli`, `@yurifrl/hub-web`, the omp plugin `@yurifrl/pi-hub`), their boundaries and import rules, the core abstractions, the error model, testing strategy, and repo conventions. Schemas of `~/.hub/` files and `hub.sock` frames are owned by `docs/02-data-contracts.md`; commands, routes, tools, and agents by `03`–`06`.

## Architecture

**Decision.** pi-hub is hexagonal (ports & adapters), package-oriented, and DRY. One word names everything: the platform you install is `pi-hub`, the core library is `@yurifrl/hub`, the nerve is `hub.sock`, the CLI is `hub`, the web app is the Hub Console, the omp tools are `hub_*`, the data root is `~/.hub/`.

Layers:

| layer | where | rule |
|---|---|---|
| domain | `lib/domain/` | pure TypeScript types and pure functions. Imports nothing: no `node:*`, no `bun:*`, no `@earendil-works/*`, no other layer. Values in, values out. |
| ports | `lib/ports/` | interfaces the core needs from the outside (`StatusStore`, `SummaryStore`, `AttentionStore`, `EventBus`, `AgentRuntime`, `Clock`). Imports domain only. |
| adapters | `lib/adapters/` | implementations of ports at the edges: filesystem, JSONL, omp subprocesses, unix socket, SSE. Imports ports + domain. All I/O lives here; zero domain logic — adapters translate between the outside world and the core. |
| hosts | `extensions/hub.ts`, `cli/`, `web/` | composition roots: instantiate adapters, inject them into ports, expose surfaces. No domain logic; parsing and presenting only. |

**Dependency direction** (arrows point at the allowed target; dependencies point inward only — the domain never imports an adapter, an adapter never imports a host):

```text
   extensions/hub.ts          cli/src/bin.ts          web/src/index.ts
   (@yurifrl/pi-hub)         (@yurifrl/hub-cli)      (@yurifrl/hub-web)
        │                          │                       │
        └──────────────┬───────────┴───────────┬───────────┘
                       ▼                       ▼
             ┌───────────────────────────────────────────┐
             │ lib — @yurifrl/hub                        │
             │                                           │
             │    adapters ───▶ ports ◀─── domain        │
             └────────────────┬──────────────────────────┘
                              ▼
      ~/.hub/   status.json · logs/<id>.jsonl · summaries.jsonl · archive/ · hub.sock
```

**Why.** The domain must stay testable without pi, without the filesystem, and without sockets — that is the point of the hexagon. Keeping hosts as thin composition roots means a new surface (a TUI, a widget, a second web view) is a renderer plugin over the same `CommandSurface`, not a fork of business logic. Package-oriented layout (one capability = one package with its own `package.json` and public `index.ts`) keeps workspaces independently type-checkable and makes "who may import whom" a checkable fact instead of a convention.

**Contract — import matrix.** Rows import the marked columns and nothing else. "barrel" = `lib/index.ts`; "adapters subpath" = `@yurifrl/hub/adapters/<name>`, exposed only through the `exports` map in `lib/package.json`.

| importer | lib/domain | lib/ports | lib/adapters | lib barrel | lib/theme | `@earendil-works/*` | node/bun std |
|---|---|---|---|---|---|---|---|
| `lib/domain` | — | no | no | no | no | **never** | no |
| `lib/ports` | yes | — | no | no | no | **never** | no |
| `lib/adapters` | yes | yes | — | no | no | **never** | yes (edge I/O only) |
| `lib/index.ts` | re-export | re-export | no | — | re-export | **never** | no |
| `cli/` (`@yurifrl/hub-cli`) | via barrel | via barrel | via subpath | yes | yes | no | yes |
| `web/` (`@yurifrl/hub-web`) | via barrel | via barrel | via subpath | yes | yes | no | yes |
| `extensions/hub.ts` (`@yurifrl/pi-hub`) | via barrel | via barrel | via subpath | yes | yes | yes (optional peers) | yes |

Rules the matrix encodes:

- lib imports nothing from omp or `@earendil-works/*`. The extension entry is the only consumer of host types.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are optional peerDependencies of the root package only, so the plugin compiles against whatever the host ships and renders through the host's TUI. lib, cli, and web never reference them.
- extensions import lib; cli and web import lib only — never each other, never the extension, never omp types directly.
- Any deep import across a package boundary (`@yurifrl/hub/domain/session`) is a defect; only barrels and documented adapter subpaths cross.

**DRY rules.** Every type is defined exactly once in `lib/domain/` — surfaces are renderer plugins over it, never re-declare it. Theme tokens are defined once in `lib/theme.ts` and consumed by every surface:

| token | value | semantics |
|---|---|---|
| accent | `#70e1c4` | chrome, selection, cursor, send |
| ok | `#3fd68f` | open, live, done |
| warn | `#f5c04e` | attention semantics: needs-you, waiting, summaries |
| err | `#ff7a9a` | failures, kill confirm |
| muted | `#8b97b0` | timestamps, ids, hints |
| session-hue | hash(sessionId) | per-session left bar; tracks one session inside any stream |

Deliberate duplications — the only sanctioned exceptions to the one-definition rule, each recorded with why coupling would be worse:

| duplication | where | why a shared abstraction is worse |
|---|---|---|
| op-name literals (`list`, `attention`, `answer`, `assign`, `send`, `tool`, `spawn`, `kill`, `archive`, `logTail`, `summaries`) | the cli commander tree; the omp plugin tool schemas | both artifacts must be statically inspectable (`hub --help` output, omp tool schema JSON) and versioned with their host; generating one from the other couples compile-time artifacts through runtime reflection and hides ops from grep |
| error presentation | cli exit codes + ANSI copy; web HTTP status + JSON body; plugin tool error text | the taxonomy lives once in domain (`HubCode`); rendering is per-medium because unifying it drags terminal/browser/user-facing copy into the core and forces a lib release for copy changes |
| output-policy parsing | cli `--json` / `--ndjson` flags; web format negotiation (query param / Accept) | same policy, two mechanics (argv vs HTTP); a lib-level "output policy" abstraction would have exactly one caller per host and leak HTTP concerns into lib |

Everything else is defined once. If two packages need a third thing, it is either a domain concept (move it into `lib/domain`) or it is added to this table with a reason.

## Package layout

```text
pi-hub/
├── package.json               # @yurifrl/pi-hub — omp plugin root; workspaces lib/cli/web; optional peers @earendil-works/*
├── lib/                       # @yurifrl/hub — hexagonal core; imports nothing from omp or the hosts
│   ├── package.json           # exports: "." (barrel) and "./adapters/*"; no omp deps
│   ├── domain/                # pure types + pure functions; zero imports
│   │   ├── session.ts         # SessionRecord, StatusFile, LogEntry, RawOmpEvent, HubEvent, phases working|waiting|idle|blocked
│   │   ├── attention.ts       # AttentionKind, AttentionItem, AttentionCandidate, proposeAttention()
│   │   ├── summary.ts         # SummaryLine {t, sessionId, kind: summary|resolution, text, by}
│   │   ├── filter.ts          # Filter: id/phase/kind/text predicates shared by every read op
│   │   └── command.ts         # Result, HubCode, HubError, OpName, CommandRequest/Reply, CommandSurface
│   ├── ports/                 # interfaces the core needs; import domain only
│   │   ├── status_store.ts    # StatusStore: read/update status.json atomically
│   │   ├── summary_store.ts   # SummaryStore: append/tail summaries.jsonl
│   │   ├── attention_store.ts # AttentionStore: list/raise/resolve attention items
│   │   ├── event_bus.ts       # EventBus: publish/subscribe hub events
│   │   ├── agent_runtime.ts   # AgentRuntime: spawn/send/kill omp agent sessions
│   │   └── clock.ts           # Clock: injected time; tests freeze it
│   ├── adapters/              # port implementations; all I/O; import ports + domain
│   │   ├── json_store.ts      # StatusStore over ~/.hub/status.json (single-writer, tmp+rename)
│   │   ├── jsonl_store.ts     # SummaryStore + log append/replay over logs/<id>.jsonl and summaries.jsonl
│   │   ├── omp_agent.ts       # AgentRuntime spawning `omp --mode acp` child sessions
│   │   ├── unix_socket.ts     # hub.sock server (hub process) + client (cli/web/plugin); newline-delimited JSON frames
│   │   └── sse_bus.ts         # EventBus → SSE stream for the web; Last-Event-ID replay
│   ├── theme.ts               # the one theme definition: tokens, palette, session-hue hash
│   └── index.ts               # public barrel: domain + ports + theme; adapters stay behind subpaths
├── cli/                       # @yurifrl/hub-cli — the `hub` binary; imports lib only
│   ├── package.json           # bin: { "hub": "./src/bin.ts" }
│   └── src/
│       ├── bin.ts             # runtime entry (a sanctioned default export); argv parsing, exit codes
│       ├── commands/          # one module per verb: parse args → CommandRequest → render reply
│       ├── render/            # ANSI painting of RenderBlocks using lib/theme.ts tokens
│       └── screens/           # full-screen views: attention board, watch, pickers
├── web/                       # @yurifrl/hub-web — Hub Console; imports lib only
│   ├── package.json
│   └── src/
│       ├── index.ts           # server assembly; injects adapters, mounts routes
│       ├── server.ts          # Bun server: static assets + SSE + JSON routes
│       └── routes/            # one module per route family; format negotiation (web's --json equivalent)
├── extensions/
│   └── hub.ts                 # omp plugin entry: reporter + 9 hub_* tools + widget; composition root
├── skills/
│   ├── hub-ops/SKILL.md       # operating recipes: send/tool/spawn/kill/archive against live sessions
│   └── hub-watcher/SKILL.md   # the hub agent loop: parse threads, raise/resolve attention, write summaries
├── agents/
│   ├── hub-watcher.md         # hub agent definition (watcher surface, OMP_HUB_AGENT=1, kind:agent)
│   └── pending-agent.md       # demo agent declaring a custom `pending` agentSurface
├── docs/                      # this spec set (01–06)
└── .unlazy/                   # acceptance gates and check scripts for the spec
```

Root manifest contract:

```json
{
  "name": "@yurifrl/pi-hub",
  "private": true,
  "workspaces": ["lib", "cli", "web"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@earendil-works/pi-tui": { "optional": true }
  }
}
```

**Why.** lib is a workspace so hosts resolve it by name (`@yurifrl/hub`) instead of relative paths, which makes the import matrix enforceable per package. The peers stay optional on the root because only `extensions/hub.ts` runs inside omp; `hub` and the web server must install and run on a machine that has never seen pi.

## Module boundaries

1. Dependencies point inward only: adapters → ports → domain. The domain never imports a port; ports never import adapters; no layer imports a host.
2. Hosts reach lib only through the barrel (`@yurifrl/hub`) or documented adapter subpaths. Deep imports across packages are defects.
3. `extensions/hub.ts` is composition root only: it registers the reporter (session_start with attached flag, user_message, assistant_message, tool_call, agent_end frames), the 9 `hub_*` tools, and the widget — nothing else. Domain logic found in the extension is in the wrong package.
4. Single writer: exactly one hub process per data root exists at a time, and it is the only writer of `status.json` (atomic tmp+rename). cli, web, and the plugin are read-only observers that mutate exclusively through ops over `hub.sock` (cmd/reply frames correlated by `cmdId`, version handshake field on connect). Startup races are resolved by an exclusive lock taken at boot (mechanism owned by `02-data-contracts`).
5. One capability = one package. There is no `utils.ts`, `helpers.ts`, or `misc.ts` anywhere in the repo; see Conventions.
6. Runtime writes stay inside `~/.hub/`. No package writes outside `pi-hub/` at build or dev time without explicit approval; the extension never edits pi settings or syncs files into `~/.pi/`.
7. Agent surfaces are data, not code: an agent declares an `agentSurface` id, and each host registers a renderer per id (default `watcher`, demo `pending`); per-agent state lives in `~/.hub/agents/<name>/surface.json`. A host that has no renderer for a declared id renders the raw stream only — it never guesses.

## Core abstractions

All types below are defined once in `lib/domain/`. Fences are type sketches only — no runnable code.

```ts
// lib/domain/command.ts — shared vocabulary for every port result and surface reply
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

type HubCode = "unavailable-hub" | "unknown-session" | "timeout" | "denied";

type HubError = {
  code: HubCode;
  message: string;        // human text, presentable as-is by any surface
  retryable: boolean;     // true only for transient unavailable-hub / timeout
  cause?: unknown;        // structured detail, never a thrown Error instance
};
```

```ts
// lib/domain/command.ts — the one op registry every surface speaks
type OpName =
  | "list" | "attention" | "answer" | "assign" | "send"
  | "tool" | "spawn" | "kill" | "archive" | "logTail" | "summaries";

type Caller = "cli" | "web" | "plugin" | "agent";

type CommandRequest = {
  cmdId: string;                     // correlation id echoed by reply frames on hub.sock
  op: OpName;
  args: Record<string, unknown>;
  by: Caller;
};

type CommandReply = Result<unknown, HubError>;

type CommandSurface = {
  dispatch(req: CommandRequest): Promise<CommandReply>;
  ops(): OpName[];                   // registry inspection feeding --help and tool schemas
};
```

The op set is the whole action vocabulary of the platform. The nine omp tools map onto it (`hub_list_sessions` → `list`, `hub_send_message` → `send`, `hub_call_tool` → `tool`, `hub_spawn_worker` → `spawn`, `hub_kill_worker` → `kill`, `hub_archive` → `archive`, `hub_attention` → `attention`, `hub_answer` → `answer`, `hub_assign` → `assign`); `logTail` and `summaries` are cli/web-only reads with no omp tool. Schemas per tool are owned by `05-omp-plugin`.

```ts
// lib/domain/session.ts — renderer plugin contract; hosts paint, domain decides
type StatusSnapshot = {
  sessions: Record<string, SessionRecord>;   // includes phase: working|waiting|idle|blocked
  attention: AttentionItem[];
  summaries: SummaryLine[];                  // tail, already filtered
  agent: { present: boolean; surfaceId: string | null };
};

type RenderBlock =
  | { kind: "orientation"; text: string }            // the agent-written one-liner
  | { kind: "attention"; items: AttentionItem[] }
  | { kind: "running"; sessions: SessionRecord[] }
  | { kind: "idle"; sessions: SessionRecord[] }
  | { kind: "log"; entries: LogEntry[] }
  | { kind: "custom"; surfaceId: string; payload: unknown };  // agent-declared surfaces

type SurfaceRenderer = {
  id: string;                        // matches agentSurface id in ~/.hub/agents/<name>/surface.json
  render(snapshot: StatusSnapshot): RenderedSurface;   // pure: snapshot in, view model out
};
```

Renderers are pure snapshot→view-model functions; the medium (ANSI, HTML) is applied by the host's paint layer using `lib/theme.ts` tokens. This is what makes terminal, web, and widget render the same hierarchy — orientation, needs-you, running, idle, stream — from one implementation.

Event normalize pipeline — raw omp event to store and bus, four stages:

```ts
// stage 1 — adapter edge (extensions/hub.ts reporter → lib/adapters/jsonl_store.ts)
type RawOmpEvent =
  | { type: "session_start"; sessionId: string; attached: boolean; cwd: string }
  | { type: "user_message"; sessionId: string; text: string }
  | { type: "assistant_message"; sessionId: string; text: string }
  | { type: "tool_call"; sessionId: string; tool: string; args: unknown }
  | { type: "agent_end"; sessionId: string; exitSummary?: string };

type LogEntry = {
  t: number;                         // Clock.now() at normalize time
  sessionId: string;
  kind: RawOmpEvent["type"];
  text: string;                      // one rendered line; no nested structures
  meta?: Record<string, unknown>;
};

// stage 2 — domain, pure (lib/domain/attention.ts): proposeAttention(entry, ctx) → candidate | null
type AttentionKind = "approval" | "question" | "blocked" | "idle";
type AttentionCandidate = {
  sessionId: string;
  kind: AttentionKind;
  text: string;
  evidence: LogEntry[];              // why this needs a human
};

// stage 3 — hub agent commits: candidate → AttentionItem via AttentionStore.raise
type AttentionItem = {
  id: string;
  sessionId: string;
  kind: AttentionKind;
  text: string;
  createdAt: number;
  resolvedAt?: number;
  answer?: string;
};

// stage 4 — fanout: every committed store change publishes on the EventBus;
// sse_bus.ts feeds the web, unix_socket.ts feeds cli/plugin watchers.
type HubEvent = { topic: "log" | "status" | "attention" | "summary"; payload: unknown };
```

Nothing renders from raw logs except the log-tail views; every attention rail, digest line, and orientation line is built from the store contract above. Ports, for reference:

```ts
// lib/ports/* — the interfaces hosts inject adapters into
type StatusStore = {
  read(): Promise<Result<StatusFile, HubError>>;
  update(mutate: (s: StatusFile) => StatusFile): Promise<Result<StatusFile, HubError>>;  // atomic
};
type SummaryStore = {
  append(line: SummaryLine): Promise<Result<void, HubError>>;
  tail(n: number, f?: Filter): Promise<Result<SummaryLine[], HubError>>;
};
type AttentionStore = {
  list(f?: Filter): Result<AttentionItem[], HubError>;
  raise(c: AttentionCandidate): Promise<Result<AttentionItem, HubError>>;
  resolve(id: string, answer: string | undefined, by: Caller): Promise<Result<AttentionItem, HubError>>;
};
type EventBus = {
  publish(evt: HubEvent): void;
  subscribe(fn: (evt: HubEvent) => void): () => void;   // returns unsubscribe
};
type AgentRuntime = {
  spawn(spec: { name?: string; model?: string }): Promise<Result<AgentHandle, HubError>>;
  send(name: string, text: string): Promise<Result<void, HubError>>;
  kill(name: string): Promise<Result<void, HubError>>;
};
type Clock = { now(): number };                        // injected; tests freeze it
```

## Error model

**Decision.** Errors are values, not exceptions. Every port method returns `Result<T, HubError>`; nothing throws across a port boundary. Adapters may throw only for programmer errors — assertion failures, misconfiguration at construction — never for expected runtime conditions. This is what lets a reply frame on `hub.sock` carry any failure losslessly and lets every surface render every failure.

Taxonomy — a closed set of four codes:

| code | meaning | typical source | cli exit | web status | plugin |
|---|---|---|---|---|---|
| `unavailable-hub` | hub process or socket not reachable | client connect fails, hub not running | 2 | 503 | tool error text |
| `unknown-session` | sessionId absent from status.json | op against a dead or mistyped id | 1 | 404 | tool error text |
| `timeout` | reply deadline exceeded | `wait_seconds` elapsed with no reply frame | 3 | 408 | tool error text |
| `denied` | op not permitted for this caller | kill/assign against the hub's own `kind:agent` session; declined confirmation on `kill` | 1 | 403 | tool error text |

**Contract.** The code set is closed; the exact cli table is owned by `03-cli`, the HTTP mapping by `04-web` — this doc fixes the codes and the rule that they are data. Forward compatibility: a surface receiving an unknown code (newer hub) renders a generic failure with the message text instead of crashing. `retryable: true` marks the only cases where a surface may auto-retry (`unavailable-hub` reconnect, `timeout` re-ask with a fresh `cmdId`); everything else is terminal for that request.

## Testing

**Decision.** `bun test` per package, zero shared test configuration; test files are `*.test.ts` colocated next to the module they exercise. Adapters receive `dataRoot` and socket path as constructor arguments — tests never touch the real `~/.hub/` and never need a new env var for isolation.

| package | level | edge/fakes |
|---|---|---|
| `lib/domain` | pure unit; no I/O, no mocks | `Clock` frozen; `Filter` and `proposeAttention` exercised as tables of cases |
| `lib/adapters` | integration against temp dirs (`mkdtemp`) | `json_store` atomicity (interrupted write leaves `status.json` valid, tmp discarded); `jsonl_store` append/replay; `unix_socket` over a temp socket path; `sse_bus` replay via `Last-Event-ID` |
| `cli` | command layer against a fake `CommandSurface` | assertions on view models, not on ANSI color codes; exit-code table pinned |
| `web` | routes via `fetch` against the server on `127.0.0.1` with a temp data root | SSE asserted through event replay, not sleeps |
| `extensions/hub.ts` | thin by rule; exercised through the reporter/tool contract with a stubbed host context | no omp runtime needed to test tool dispatch |

- **Domain pure unit:** every domain function is deterministic given an injected `Clock`; there is nothing to mock because there is nothing to inject but data.
- **Adapters vs temp dirs:** each adapter test builds its own temp `dataRoot`, so tests run in parallel without cross-talk and a crashed test leaves no residue.
- **One e2e:** a single test assembles the real composition root — hub process with a temp data root and a unix socket at a temp path — plus two fake sessions (scripted fixtures that emit reporter frames and answer cmd frames). It asserts the full spine: `session_start` lands both sessions in `status.json`; a `tool_call` proposing approval raises an `AttentionItem`; the `answer` op resolves it and appends a `kind:"resolution"` line to `summaries.jsonl`; `archive` moves the closed record to `archive/YYYY-MM/<id>.json`. This is the only test that spans packages; everything below it is unit or integration.

## Conventions

- **File naming:** kebab-case modules (`json_store.ts`, `status_store.ts`), PascalCase exported types, one module = one cohesive concern. Test files are `*.test.ts` colocated beside the tested module; larger fixtures live in `testdata/` under the owning package.
- **Barrel exports:** each package exports only through its `index.ts` (`@yurifrl/hub`), plus adapter subpaths declared in `lib/package.json` `exports`. Reaching past a barrel from another package is a defect.
- **No default exports except bins:** `cli/src/bin.ts` (bun bin entry) and `extensions/hub.ts` (omp loads it as the plugin entry) are the only default exports; everything else is a named export so tree-shaking and grep stay honest.
- **No grab-bag utils:** `utils.ts`, `helpers.ts`, `misc.ts`, `common.ts` are banned. Shared code is either a domain concept (moves into `lib/domain`) or a recorded deliberate duplication (table above).
- **No side effects at module load:** everything runs from entry handlers or `main()`; adapters do work only when their methods are called.
- **Function shape:** max ~2 nesting levels — extract a function instead. No giant handlers: a host handler parses, dispatches one `CommandRequest`, and forwards the reply to the paint layer.
- **Docs are decision records:** each doc states decision, why, contract; H1 + one-line scope sentence, H2 sections, dense markdown, types in fences, no emoji, no runnable code.
