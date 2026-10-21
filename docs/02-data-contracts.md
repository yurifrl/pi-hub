# pi-hub — Data contracts

On-disk and wire contracts for the hub — `status.json`, `logs/<id>.jsonl`,
`summaries.jsonl`, the `archive/YYYY-MM/` tree, and the `hub.sock` frame
protocol; this doc is the shape and frame owner, and 03, 04, 05, 06 are
consumers that reference it, never restate it. Conventions: timestamps are
ISO 8601 UTC strings (e.g. `2026-08-30T17:57:51.401Z`); `sessionId` is the
omp session id verbatim, never re-encoded or shortened; attention item ids
are hub-minted `att-<n>` from the monotonic counter `nextAttentionId` in the
meta block, so ids survive hub restarts; all types live once in
`lib/domain/` (01-architecture), tables here are normative field lists, and
fenced `ts` blocks are type sketches only — no imports, no runtime code.

## status.json

`~/.hub/status.json` is one JSON object holding every live fact: the hub
meta block, the `sessions` map, open `attention[]` items, and the
`archived[]` tombstone index. It is the only mutable state file; everything
else is append-only logs or immutable archive records.

**Single writer:** only the hub process writes it. Enforcement is an
exclusive `flock` on `~/.hub/hub.lock` held for the hub's lifetime; a
second hub instance fails to acquire the lock and exits (CLI exit code 2 —
unavailable). CLI and web never write the file — they read it directly or
take a `list` reply over `hub.sock`; every mutation flows through an op
that only the hub process applies.

**Atomic rewrite:** writers replace the whole object — serialize, write
`status.json.tmp`, fsync, `rename(2)` over the target. Readers observe
either the previous or the next complete object, never a torn file. A
stale `status.json.tmp` is unlinked by the hub on start.

### Hub meta block

| field | type | required | contract |
|---|---|---|---|
| `version` | number | yes | schema version, currently `1`; bump rules in ## Versioning |
| `startedAt` | string | yes | hub process start time (UTC) |
| `pid` | number | yes | writer pid; readers may use it to detect a dead hub |
| `nextAttentionId` | number | yes | counter for the next `att-<n>` id |
| `digest` | string | no | hub-agent orientation one-liner, refreshed per agent cycle; absent when the agent is off (surfaces synthesize counts as fallback) |
| `agentSession` | string | no | `sessionId` of the hub agent itself; present while the agent runs |

### sessions map

`sessions` maps `sessionId` → `SessionRecord`. Key order is insertion
order (session_start arrival); readers must not rely on it.

| field | type | required | contract |
|---|---|---|---|
| `status` | `"open" \| "closing"` | yes | `"closing"` between a close request and archive completion |
| `kind` | `"peer" \| "self" \| "worker" \| "agent"` | yes | peer: attached external session; self: the session hosting the plugin that started this hub; worker: spawned via the `spawn` op; agent: the hub agent |
| `cwd` | string | yes | working directory reported at session_start |
| `title` | string | yes | first user message, truncated to 80 chars |
| `model` | string | yes | model id reported at session_start |
| `description` | string | no | agent-written one-liner: what the session is doing now |
| `phase` | `"working" \| "waiting" \| "idle" \| "blocked"` | yes | current digest phase; defaults `"working"` |
| `phaseHistory` | `{ phase: Phase, at: string }[]` | no | appended on every phase transition, capped at 50 entries (oldest dropped); absent when the agent is off or nothing was recorded |
| `log` | string | yes | link `logs/<id>.jsonl`, relative to `~/.hub/` — never log content |
| `toolCounts` | `Record<string, number>` | yes | tool name → call count; starts `{}` |
| `turns` | number | yes | user turns observed; starts `0` |
| `startedAt` | string | yes | from session_start |
| `lastActivity` | string | yes | timestamp of the last reporter frame of any kind |
| `agentSurface` | string | no | declared surface id (06-agents-and-skills); surfaces default to `watcher` |

Type sketch (mirrors `lib/domain/session.ts`):

```ts
type Phase = "working" | "waiting" | "idle" | "blocked";
type SessionKind = "peer" | "self" | "worker" | "agent";

interface SessionRecord {
  status: "open" | "closing";
  kind: SessionKind;
  cwd: string;
  title: string;
  model: string;
  description?: string;
  phase: Phase;
  phaseHistory?: { phase: Phase; at: string }[];
  log: string; // "logs/<id>.jsonl" — a link, never content
  toolCounts: Record<string, number>;
  turns: number;
  startedAt: string;
  lastActivity: string;
  agentSurface?: string;
}
```

### attention[]

Top-level `attention` holds **open items only** — `AttentionItem` records
that have not resolved. Resolved items are removed in the same rewrite
that appends their resolution line to `summaries.jsonl` (## Attention
lifecycle).

| field | type | required | contract |
|---|---|---|---|
| `id` | string | yes | `att-<n>`, hub-minted |
| `sessionId` | string | yes | session the item is about |
| `kind` | `"approval" \| "question" \| "blocked" \| "idle"` | yes | semantics in ## Attention lifecycle |
| `text` | string | yes | human-readable one-liner |
| `createdAt` | string | yes | |
| `resolvedAt` | string | no | set at most once, alongside `answer` |
| `answer` | string | no | the delivered answer; absent for dismissals |

```ts
type AttentionKind = "approval" | "question" | "blocked" | "idle";

interface AttentionItem {
  id: string;
  sessionId: string;
  kind: AttentionKind;
  text: string;
  createdAt: string;
  resolvedAt?: string; // set exactly once, if ever
  answer?: string; // set exactly once, alongside resolvedAt
}
```

### archived[]

Tombstone index of recently closed sessions, oldest first:

| field | type | contract |
|---|---|---|
| `id` | string | closed `sessionId` |
| `path` | string | archive record path, e.g. `archive/2026-08/s-c0de.json` |
| `closedAt` | string | mirrors the archive record |

Capped at 200 entries; on overflow the oldest link is dropped. The archive
tree itself is never pruned — `archived[]` is a recent-closers index for
boards, not the history of record.

### Invariants

1. **Open until closed.** A session exists in `sessions` from
   `session_start` until a proper close: the `kill` op, a reporter
   farewell (`agent_end` with `reason:"exit"`), or the hub-restart reaper
   (invariant 8). A crashed reporter does not close its session — the
   record stays until a close path runs.
2. **Close path is remove-then-archive, one rename.** On close the record
   is deleted from `sessions`, the full record is written to
   `archive/YYYY-MM/<id>.json` (with `closedAt`, `closedBy`,
   `finalSummary`, resolution tail — ## archive), and an `archived[]`
   link is appended. All three land in a single atomic status.json
   rewrite, ordered after the archive file is durably written.
3. **`log` is a link, never content.** Status must stay small and cheap
   to rewrite on every event; the raw stream lives in `logs/<id>.jsonl`.
4. **Single writer.** Exactly one hub process (flock-guarded) writes;
   every other process reads.
5. **Atomic rewrite** for every write (tmp + fsync + rename).
6. **Unknown fields ignored.** Readers tolerate unknown fields at every
   level — forward compatibility (## Versioning).
7. **`version` is the first field** of the meta block, so a reader can
   reject an unknown future format before parsing further.
8. **Crash recovery.** On start the hub loads the existing status.json;
   sessions that do not re-announce via `session_start` within a 60s
   grace window are closed and archived with `closedBy:"hub-restart"` and
   a `finalSummary` synthesized from the record's last `description`.
   Reporters announce on every start, so a still-running omp session
   re-attaches and keeps its record untouched.

### Example

Realistic mid-flight state — one attached peer waiting on an approval, one
worker idle, two open attention items:

```jsonc
{
  // hub meta block
  "version": 1,
  "startedAt": "2026-08-30T17:42:10.113Z",
  "pid": 43187,
  "nextAttentionId": 8,
  "digest": "tilt needs approval for deploy canary; atlas is idle with no assigned work",
  "agentSession": "s-hub-01",

  "sessions": {
    "s-9f2c": {
      "status": "open",
      "kind": "peer",
      "cwd": "/Users/yuri/DotFiles",
      "title": "review the tilt deploy plan",
      "model": "aihub/glm-5.3-flash",
      "description": "mid-review of deploy plan; paused on canary approval",
      "phase": "waiting",
      "phaseHistory": [
        { "phase": "working", "at": "2026-08-30T17:43:02.881Z" },
        { "phase": "waiting", "at": "2026-08-30T17:52:19.400Z" }
      ],
      "log": "logs/s-9f2c.jsonl",
      "toolCounts": { "read": 14, "edit": 3, "bash": 7 },
      "turns": 9,
      "startedAt": "2026-08-30T17:42:58.201Z",
      "lastActivity": "2026-08-30T17:52:19.400Z"
    },
    "s-4a71": {
      "status": "open",
      "kind": "worker",
      "cwd": "/Users/yuri/DotFiles/pi-extentions/pi-hub",
      "title": "worker atlas",
      "model": "aihub/glm-5.3-flash",
      "description": "idle since finishing the docs skeleton",
      "phase": "idle",
      "log": "logs/s-4a71.jsonl",
      "toolCounts": { "read": 6, "write": 2 },
      "turns": 3,
      "startedAt": "2026-08-30T18:01:44.710Z",
      "lastActivity": "2026-08-30T18:14:02.355Z",
      "agentSurface": "watcher"
    }
  },

  "attention": [
    {
      "id": "att-6",
      "sessionId": "s-9f2c",
      "kind": "approval",
      "text": "approve deploy canary 2/3 for tilt",
      "createdAt": "2026-08-30T17:52:19.400Z"
    },
    {
      "id": "att-7",
      "sessionId": "s-4a71",
      "kind": "question",
      "text": "atlas asks: target branch for the docs PR?",
      "createdAt": "2026-08-30T18:13:58.020Z"
    }
  ],

  "archived": [
    {
      "id": "s-c0de",
      "path": "archive/2026-08/s-c0de.json",
      "closedAt": "2026-08-30T16:59:41.900Z"
    }
  ]
}
```

## logs

`~/.hub/logs/<id>.jsonl` — one append-only file per session, created at
`session_start`. The first line is always a `system` event
recording the `session_start` frame, including the `attached` flag (true
when the plugin attached to an already-running session) and the session
`kind`, so a log file self-describes how it began.

Event line shape:

| field | type | required | contract |
|---|---|---|---|
| `t` | string | yes | UTC timestamp |
| `sessionId` | string | yes | denormalized from the filename so lines are self-contained |
| `kind` | `"prompt" \| "tool" \| "result" \| "think" \| "message" \| "system"` | yes | see table below |
| `text` | string | yes | the payload; tool args/results are summarized, truncated to 2 KB per line |
| `meta` | object | no | free-form per-kind extras; readers ignore unknown keys |

| kind | emitted on | typical `meta` |
|---|---|---|
| `prompt` | `user_message` frame | — |
| `tool` | `tool_call` frame | `{ tool, argsSummary }` |
| `result` | tool result | `{ tool, ok, durationMs }` |
| `think` | assistant thinking | — |
| `message` | `assistant_message` frame | — |
| `system` | lifecycle events | `{ event: "session_start" \| "agent_end" \| "close", ... }` |

Durability contract: lines are appended with a single `write(2)` at
`O_APPEND`; a crash may lose the tail of the last line but never corrupts
earlier ones. On read, a trailing line without a newline is discarded.
Files are never rewritten or compacted — the only mutation is append.
Log files outlive their sessions: archive records link to them and they
are never deleted (retention is explicitly out of scope for v1).

`hub log -f` (03-cli) tails this file; the web stream (04-web) replays
it. Neither extracts content from status.json — the `log` link is the
contract between them.

## summaries.jsonl

`~/.hub/summaries.jsonl` — one global append-only file, the AI digest
rail. Line shape:

| field | type | required | contract |
|---|---|---|---|
| `t` | string | yes | UTC timestamp |
| `sessionId` | string | yes | session the line is about |
| `kind` | `"summary" \| "resolution"` | yes | see below |
| `text` | string | yes | summary text, or resolution description |
| `by` | string | yes | author: `agent` for summaries; the resolver (`cli`, `web`, a closing session id, `hub-restart`, `auto`) for resolutions |

- `kind:"summary"` — written once per agent cycle per session: what
  happened since the previous line. Authored by the hub agent; the **hub
  process performs the write** (the agent asks via ops), keeping
  `summaries.jsonl` under the same single-writer rule as `status.json`.
- `kind:"resolution"` — appended by the hub process the moment an
  AttentionItem resolves. `text` is `resolved <item.id> (<kind>): <answer>`;
  for dismissals the answer portion reads `dismissed`, for agent
  auto-resolves `auto`. The full answer travels in the line so the
  history survives the item's removal from `status.json`.

Resolutions recorded as `kind:"resolution"` with the answer — this is the
audit trail for attention (## Attention lifecycle). Append-only, same
durability rules as ## logs (single append per line, torn tail
discarded). No per-line schema version: new optional fields may appear;
readers ignore unknown keys.

## archive

`~/.hub/archive/YYYY-MM/<id>.json` — one immutable record per closed
session, filed under the UTC month of `closedAt`. Written once, never
rewritten; the `archived[]` link in `status.json` points at it.

Contents: the `SessionRecord` exactly as last seen, plus the close tail:

| field | type | required | contract |
|---|---|---|---|
| *(SessionRecord fields)* | — | yes | as-last-seen snapshot, including `phase`, `toolCounts`, `turns`; `status` freezes at `"closing"` |
| `closedAt` | string | yes | UTC close time; also selects the `YYYY-MM` directory |
| `closedBy` | string | yes | `cli`, `web`, the closing session's id (via `hub_kill_worker`), `self` (reporter farewell), or `hub-restart` |
| `finalSummary` | string | yes | last agent summary for the session; synthesized from the last `description` when the agent is off |
| `resolutions` | `AttentionItem[]` | no | every item resolved during the session's life, in resolve order, `resolvedAt` set |
| `version` | number | no | status.json schema version at close time, for future-format forensics |

`log` inside the record stays a link; the log file is retained. Close
orders: the `kill` op (graceful: set `status:"closing"` → reporter
farewell → archive write), reporter farewell, hub-restart reaper. All
three funnel through the same one-rename close path (invariant 2).

Example — the record for the session tombstoned in the status.json
example above:

```jsonc
{
  // SessionRecord snapshot, as last seen
  "status": "closing",
  "kind": "peer",
  "cwd": "/Users/yuri/DotFiles",
  "title": "draft hub data contracts",
  "model": "aihub/glm-5.3-flash",
  "description": "finished; closed after final summary",
  "phase": "idle",
  "phaseHistory": [
    { "phase": "working", "at": "2026-08-30T15:10:02.001Z" },
    { "phase": "idle", "at": "2026-08-30T16:58:59.700Z" }
  ],
  "log": "logs/s-c0de.jsonl",
  "toolCounts": { "read": 31, "edit": 12, "bash": 4 },
  "turns": 22,
  "startedAt": "2026-08-30T15:09:44.500Z",
  "lastActivity": "2026-08-30T16:59:40.900Z",

  // close tail
  "closedAt": "2026-08-30T16:59:41.900Z",
  "closedBy": "cli",
  "finalSummary": "Wrote the data-contract draft: status.json, logs, summaries, archive, hub.sock framing, attention lifecycle; log retention left as an open question for review.",
  "resolutions": [
    {
      "id": "att-3",
      "sessionId": "s-c0de",
      "kind": "question",
      "text": "keep raw logs forever?",
      "createdAt": "2026-08-30T15:40:12.300Z",
      "resolvedAt": "2026-08-30T15:41:02.000Z",
      "answer": "yes for v1; retention is out of scope"
    }
  ],
  "version": 1
}
```

## hub.sock

`$OMP_HUB_SOCK` (default `~/.hub/hub.sock`) — a Unix domain SOCK_STREAM
socket. The protocol is newline-delimited JSON frames in both directions:
one JSON object per `\n`-terminated frame, UTF-8, no framing escapes.
Every frame carries `v` (frame-protocol version, currently `1`). The hub
is the server; clients are the plugin reporter (one connection per
session), the CLI (one-shot cmd/reply), the web server (long-lived,
subscribed), and the hub agent (long-lived, subscribed).

### Handshake

First frame from any client:

```jsonc
{ "v": 1, "ch": "hello", "client": "cli", "subscribe": false }
```

`client` is `cli | web | plugin | agent`; `subscribe: true` (web server,
hub agent) additionally opts into unsolicited `event` frames (below). The
hub replies `{ "v": 1, "ch": "hello", "hub": { "version": 1, "startedAt": "..." } }`.
A major-version mismatch is answered with an error frame (`bad-version`)
and the connection is closed; minor drift is tolerated — unknown fields
ignored, the same rule as `status.json`.

### Reporter frames (plugin → hub, `ch:"report"`)

Emitted by the omp plugin (05-omp-plugin) as the session runs. Shape:
`{ v, ch:"report", frame: <name>, ...payload }`. Reporter frames are
fire-and-forget — no reply, no cmdId; socket order is record order.

| frame | payload | effect on status.json |
|---|---|---|
| `session_start` | `sessionId`, `kind`, `cwd`, `model`, `attached` | upserts the SessionRecord; `attached` is true when the plugin attached to an already-running session |
| `user_message` | `sessionId`, `text` | bumps `turns` and `lastActivity` |
| `assistant_message` | `sessionId`, `text` | bumps `lastActivity` |
| `tool_call` | `sessionId`, `tool`, `args` | bumps `toolCounts[tool]` |
| `agent_end` | `sessionId`, `reason` | `reason: "complete" \| "interrupted" \| "exit"`; `exit` is a proper close (self-exit) |

```jsonc
{ "v": 1, "ch": "report", "frame": "tool_call", "sessionId": "s-9f2c", "tool": "bash", "args": { "command": "bun test" } }
```

### cmd/reply frames (any client → hub)

| field | required | contract |
|---|---|---|
| `v` | yes | protocol version |
| `ch` | yes | `"cmd"` |
| `cmdId` | yes | client-minted correlation id (e.g. `cli-43187-12`); replies echo it; replies may arrive out of order |
| `op` | yes | one of the ops below |
| payload | per op | below |

Reply frames: `{ v, ch:"reply", cmdId, ok:true, result }` or
`{ v, ch:"reply", cmdId, ok:false, error: { code, message } }`. Every op
runs under a 30s deadline; expiry replies `error.code:"timeout"`. `tool`
is the one exception: when queued behind a busy target session its
deadline extends to 120s from first execution.

### Ops

| op | request | reply `result` | notes |
|---|---|---|---|
| `list` | `{}` | `{ hub, sessions, attention, archived }` | full status snapshot; boards use it as their refresh base |
| `send` | `{ sessionId, text }` | `{ queued: true }` | delivers `text` as a user turn to the session |
| `tool` | `{ sessionId, tool, args }` | the tool's JSON result | runs the tool inside the target session |
| `spawn` | `{ name?, model? }` | `{ sessionId, name }` | spawns a worker session (`kind:"worker"`) |
| `kill` | `{ sessionId }` | `{ closedAt }` | proper close: `status:"closing"` → graceful farewell → archive write; replies after the close path completes |
| `attention` | see below | see below | list / raise / dismiss — one op, three actions |
| `answer` | `{ id, text }` | `{ item }` | delivers `text` to the item's session (send semantics), then resolves the item |
| `assign` | `{ sessionId, task }` | `{ item }` | creates the pending assigned-work item (## Attention lifecycle) |
| `agent` | `{}` | `{ started: true, name, adopted? }` | starts the hub's own agent through the watcher's supervised spawn path; adopts a live child instead of erroring when one already runs |
| `ping` | `{}` | `{ pong: true }` | side-effect-free liveness probe: one full dispatch round-trip proves socket, parser, and core; `hub ping` (03-cli) and `bridge/run` build on it |

The `attention` op:

| action | request | reply |
|---|---|---|
| list | `{}` | `{ items: AttentionItem[] }` — open items only, newest first |
| raise | `{ action: "raise", item: { sessionId, kind, text } }` | `{ item }` — hub agent only; other clients get error `forbidden` |
| dismiss | `{ action: "dismiss", id }` | `{ item }` — resolve without answer; the resolution line records `dismissed` |

(03-cli maps the board's `d` key to dismiss and `a` to assign;
`hub_attention` / `hub_answer` / `hub_assign` in 05-omp-plugin map to
list / answer / assign.)

### Event frames (hub → subscribed clients, `ch:"event"`)

Clients that subscribed receive unsolicited frames mirroring activity, so
the web server can feed its SSE stream (04-web) and the agent can watch
threads without polling:

```jsonc
{ "v": 1, "ch": "event", "kind": "attention", "item": { "id": "att-6", "sessionId": "s-9f2c", "kind": "approval", "text": "approve deploy canary 2/3 for tilt", "createdAt": "2026-08-30T17:52:19.400Z" } }
```

`kind` is one of the five reporter frame names (same payload), plus
`attention` (payload: the touched AttentionItem after the change; a
removal carries `resolvedAt`) and `phase` (payload:
`{ sessionId, phase, at }`). Event frames are best-effort — a slow
consumer gets dropped frames, never blocked writers; the `list` op is the
authoritative snapshot.

### Error frames and concurrency

Protocol-level failures (bad `v`, malformed JSON, unknown `ch`) get an
unsolicited `{ v, ch:"error", error: { code, message } }` frame with
`cmdId` when one is known; malformed input closes the connection. Error
codes: `bad-frame`, `bad-version`, `unknown-op`, `forbidden`,
`no-session`, `timeout`, `busy`. The hub serializes all state mutations
(single-writer); concurrent cmds interleave and correlate by `cmdId`. A
`kill` of a session with in-flight cmds fails those cmds with
`no-session`.

## Attention lifecycle

Attention is the queue of things a human should look at. It is
**agent-mediated**: the hub agent (06-agents-and-skills) watches all
threads and raises items; surfaces render them; humans resolve them.
`attention[]` in `status.json` holds open items only — resolution removes
the item and appends the permanent record to `summaries.jsonl`.

**Kinds** (`AttentionItem.kind`):

| kind | meaning | raised when |
|---|---|---|
| `approval` | a yes/no is needed | the session asks for approval (tool confirm, deploy gate) |
| `question` | the agent asked the human something | an assistant turn ends with a direct question |
| `blocked` | the session cannot proceed | missing credential, failed dependency, repeated tool failure |
| `idle` | the session waits for work — including pending assigned work | `agent_end` with no follow-up, or an `assign` op |

**Raise.** Only the hub agent raises, via the `attention` op with
`action:"raise"`; the hub verifies the caller — hello `client:"agent"`
whose session id matches meta `agentSession` (the agent itself is spawned
with `OMP_HUB_AGENT=1`, 06-agents-and-skills). Raising is idempotent per
`(sessionId, kind)`: if an open item with that pair exists, its `text` is
updated in place and the existing id is returned — no duplicate items
while a session stays in the same state. A new id is minted only after
the older item resolved.

**Resolve.** Three paths, all through the hub process, all idempotent:

| path | trigger | `answer` |
|---|---|---|
| `answer` op | human text delivered (CLI board, web input, `hub_answer`) | the delivered text |
| `dismiss` action | resolve without replying (board `d` key, web ✕) | absent — resolution line reads `dismissed` |
| agent auto-resolve | the agent observes the condition cleared (approval granted in-thread, session unblocked, assigned work picked up) | absent — resolution line reads `auto` |

Idempotency rule: the first resolve wins. A resolve on an unknown or
already-resolved id replies `ok:true` with the existing item and appends
nothing — races between CLI and agent must not double-append resolution
lines. On resolve the item is removed from `attention[]` in the same
atomic rewrite that precedes the `summaries.jsonl` append
(`kind:"resolution"`, `text: "resolved <id> (<kind>): <answer>"`, `by`:
the resolver). `status.json` never holds resolved items; `summaries.jsonl`
is their only history, and the session's archive record folds them into
its `resolutions` tail.

**Assign.** The `assign` op (`hub_assign`, web assign input, board `a`
key) targeting an idle session creates a pending item linked to the
target session: `AttentionItem { kind:"idle", text: "assigned: <task>" }`.
It stays open — the visible marker of outstanding work — until the hub
agent sees the session leave `idle` (auto-resolve) or a human dismisses
or answers it. With the agent off, assigned items resolve only manually.

**Rendering tie-in.** This section is data-only; color belongs to
`lib/theme.ts` — open items render in the attention color (`warn`
`#f5c04e`), `blocked` items in `err` `#ff7a9a`, answer inputs and
selection chrome in `accent` `#70e1c4`. The widget (05) and the CLI board
(03) share that mapping; no surface redefines it.

## Versioning

- `status.json` carries `version` (currently `1`) as the first meta
  field. One integer, additive meaning: a bump signals "readers written
  for the previous version must still work" — it is required only when a
  field's meaning changes, never when fields are added.
- **Forward compatibility:** readers ignore unknown fields at every level
  (meta block, SessionRecord, AttentionItem, socket frames, log and
  summary lines). Writers never remove or repurpose fields within a
  version. The `phase` and `kind` enumerations may grow; readers treat
  unknown enum values as opaque strings (render generically), never as
  errors.
- **Wire:** `hub.sock` frames carry `v`; the `hello` handshake
  negotiates. A major mismatch gets `bad-version` and a close; because
  the framing is NDJSON with a version per frame, a hub upgrade can serve
  mixed client versions across a rolling restart.
- **Append-only files:** `logs/<id>.jsonl` and `summaries.jsonl` have no
  header or version line — their contract is "additive fields only; files
  are never rewritten". If a breaking change is ever unavoidable, the
  file rotates (`summaries-2.jsonl`) and the active generation is named
  by a new optional meta field `summariesGeneration` (decision: rotation
  over in-place rewrite; rewriting append-only files would break every
  concurrent reader).
- **Archive records** embed the `version` they were written at (optional
  field), so old records stay interpretable if the SessionRecord shape
  ever drifts.
- **Atomicity, restated:** every `status.json` rewrite is tmp-write →
  fsync → rename. Rename is atomic on POSIX; readers never lock. A crash
  between write and rename leaves `status.json.tmp`, which the next hub
  start unlinks. The `flock` on `~/.hub/hub.lock` guarantees one writer
  across crashes — a dead hub's lock dies with it, so a restart can
  always take over and run crash recovery (invariant 8).

---

Cross-references: 01-architecture defines the ports these files sit
behind (`StatusStore`, `SummaryStore`, `AttentionStore`); 03-cli, 04-web
and 05-omp-plugin are the read surfaces and the reporter; 06-agents-and-skills
owns raise and auto-resolve behavior.
