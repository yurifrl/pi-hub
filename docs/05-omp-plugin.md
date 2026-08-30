# omp plugin

`extensions/hub.ts` in `@yurifrl/pi-hub` — the omp extension that turns any session into the hub and wires every other session to it, as a thin driving adapter over `@yurifrl/hub`.

The plugin owns no policy. Persistence, attention, summaries, and routing live in lib behind ports (`StatusStore`, `SummaryStore`, `AttentionStore`, `EventBus`, `AgentRuntime`, `Clock`); the extension only translates pi events into hub frames and hub replies into tool results, and renders the widget. The lib composition root (see 01-architecture) is injected with adapters (`json_store`, `jsonl_store`, `omp_agent`, `unix_socket`, `sse_bus`) when the hub starts. Key decisions are recorded as `DECISION / WHY / CONTRACT` blocks, match-day style.

## Entry

One default export; all state lives inside the factory closure:

```ts
// extensions/hub.ts — @yurifrl/pi-hub entry
export default function hub(pi: ExtensionAPI): void
```

DECISION — brain early-return.
WHY: hub-spawned RPC children — the `omp --mode rpc` brain and workers — load the same extension and get `OMP_HUB_BRAIN=1`. Without a guard every child would try to serve the socket or report to itself, forking the hub forever. (The hub agent does NOT get this flag; it loads the extension fully and is bounded instead by guards 5–6 in ## Anti-recursion.)
CONTRACT: when `process.env.OMP_HUB_BRAIN === "1"`, the factory returns before any `pi.on`, `pi.registerTool`, or `pi.registerCommand`. The child contributes nothing but RPC answers. This is the first and hardest anti-recursion guard (## Anti-recursion).

Commands, registered only after the guard:

| command | behavior |
|---|---|
| `/hub-start` | make this session the hub (steps below) |
| `/hub-stop` | stop serving; keep the session running (## Shutdown) |
| `/hub-agent` | spawn or adopt the hub agent (## Agent spawn) |

`/hub-start`, in order:

1. `setWidget("omp-hub-stream", ...)` — claims the widget slot. The key `omp-hub-stream` is the contract with omp's UI: stable across renders, cleared on `/hub-stop`.
2. Compose the core: `json_store` → `StatusStore` (`~/.hub/status.json`), `jsonl_store` → logs + `SummaryStore` (`summaries.jsonl`), `sse_bus` → `EventBus`, `AttentionStore` over the `StatusStore`. Inject into the lib composition root.
3. Spawn the brain through the `AgentRuntime` port (`omp_agent` adapter): `OMP_BIN` `--mode rpc`, env `OMP_HUB_BRAIN=1`, plus `OMP_HUB_MODEL` when set. Readiness = version handshake on the RPC channel.
4. Serve `~/.hub/hub.sock` through the `unix_socket` adapter: newline-delimited JSON frames; reporter events in, cmd/reply out. A stale socket file from a crashed hub is unlinked before listen.
5. Register self in `status.json` (session record with meta flag `kind:"hub"`) and render the widget.

DECISION — one well-known socket address.
WHY: reporter, `hub` CLI, and Hub Console must find the hub without config.
CONTRACT: the path is `~/.hub/hub.sock`, overridable by `OMP_HUB_SOCK`; every surface resolves it the same way. The omp-era `~/.omp/hub.sock` is dead.

## Reporter

Runs in EVERY session — including the hub session, via a local self-feed instead of the socket. One reporter instance per process; every handler follows the error rules (## Tools › Error rules).

Event translation table:

| pi event | frame | notes |
|---|---|---|
| `session_start` | `session_start` `attached:false` | carries `sessionId`, `title`, `cwd` |
| `input` | `user_message` | typed text; commands (leading `/`) are skipped — they are UI, not conversation |
| `message_end` (role `assistant`) | `assistant_message` | text + model |
| `message_end` (role `user`) | `user_message` | fallback capture: delivered/enqueued prompts that never pass through `input`; `<`-prefixed wrapper blocks skipped |
| `tool_execution_start` | `tool_call` | tool name + JSON-stringified args (best effort; unserializable args become `""`) |
| `agent_end` | `agent_end` | flips the session's phase in hub state (working → idle/waiting) |
| `session_shutdown` | `session_end` | best-effort frame; hub closes that one session properly (## Shutdown) |

DECISION — two capture paths for user input.
WHY: typed input fires `input`; messages delivered by the hub or queued by the harness arrive only as user-role `message_end`. Capturing both is the difference between a roster and a log.
CONTRACT: `input` is authoritative when present; `message_end` user-role frames are the fallback and skip `<...>`-wrapped system payloads so skill injections never pollute the log.

Self-feed: when `hubActive && sessionId === selfSessionId`, frames bypass the socket and go straight into the hub's event handler. The hub watches itself exactly like a peer, minus the round-trip (and minus recursion risk — ## Anti-recursion).

Attach-on-connect. The reporter owns one reconnecting socket with a bounded outbox (last 500 frames, dropped wholesale above 50 on close). On EVERY successful connect it first enqueues:

```text
{"kind":"session_start","v":1,"attached":true,"sessionId":"a3f2","title":"tilt","cwd":"~/work/api"}
```

DECISION — attach is a frame, not a handshake endpoint.
WHY: sessions outlive hubs. A session started before the hub — or surviving a hub restart — must appear on the roster with no user action.
CONTRACT: `attached:true` means "pickup of an existing session"; the hub upserts by `sessionId`, so reconnects and hub restarts are idempotent — no duplicate rows, no duplicate attention. `attached:false` appears only in the original `session_start` emission. All frames carry `v:1`; a hub that cannot honor the major version replies once with `ok:false` ("version mismatch") instead of silently dropping frames.

Inbound frames handled by the reporter, exactly two:

- `deliver` → `sendUserMessage(text)` — the only inbound mutation of the host session.
- `reply` → resolves the matching pending cmd by `cmdId`.

Outbound cmds (`reporterCmd(op, payload, timeoutMs)`): stamp `cmdId`, enqueue `{kind:"cmd", cmdId, op, ...payload}`, resolve on reply `{cmdId, ok, text}`. On timeout: resolve `{ok:false, text:"hub command timed out — is the hub running /hub-start?"}`. Never throws.

## Tools

All nine tools are registered in every non-brain session via `pi.registerTool({ name, label, description, parameters, execute })` with `z = pi.zod`. One dispatch rule for every tool:

- **hub-local** — when `hubActive && sessionId === selfSessionId`: call the lib command surface directly. Workers go through `AgentRuntime` handles; sessions through `resolveTarget` (session-id prefix or title substring) + deliver.
- **peer relay** — everyone else: cmd frame over `hub.sock`, await the correlated reply.

```text
→ {"kind":"cmd","v":1,"cmdId":"c7","op":"send","target":"tilt","text":"…","waitMs":0}
← {"kind":"reply","cmdId":"c7","ok":true,"text":"delivered; no reply requested"}
```

Timeouts are per-tool (stated inline in each tool's Routing line). Every timeout resolves `{ok:false}` with the timeout text — tools never throw. Ops: `list`, `send`, `tool`, `spawn`, `kill`, `archive`, `attention`, `answer`, `assign`.

### hub_list_sessions

Description (registered): "List all live OMP sessions on the hub plus its RPC workers. Requires the hub to be active (/hub-start in the hub terminal)."

```ts
// parameters: z.object({}) — no arguments
{}
```

Routing: hub-local → render the `StatusStore` snapshot (roster: id, title, phase, description, lastActivity, kind). Peer relay → op `list`. Timeout 10s.

### hub_send_message

Description: "Send a message into another live OMP session via the hub. The target's agent receives it as a user message. Set wait_seconds to also return its reply."

```ts
{
  target:       z.string().describe("worker name, session id prefix, or title substring"),
  message:      z.string().describe("text delivered into the target session as a user message"),
  wait_seconds: z.number().int().min(0).max(600).optional().describe("also wait for the target's reply; default 0"),
}
```

Routing: hub-local → worker? `AgentRuntime` promptAndWait (always awaits completion, bounded by `max(waitMs, 240s)`) : `resolveTarget` → deliver into the session, optionally await its reply. Peer relay → op `send` `{target, text, waitMs}`. Timeout `max(wait_seconds*1000 + 15s, 30s)`.

### hub_call_tool

Description: "Make another OMP session (or RPC worker) call a tool and report the result. For workers this is a direct round-trip returning the actual result."

```ts
{
  target:       z.string().describe("worker name, session id prefix, or title substring"),
  tool:         z.string().describe("tool name, e.g. bash, read, write"),
  args:         z.string().optional().describe('tool arguments as JSON, e.g. {"command":"ls"}'),
  wait_seconds: z.number().int().min(0).max(600).optional().describe("seconds to wait for the result; default 240"),
}
```

Routing: hub-local → worker? direct RPC tool round-trip (the real tool result comes back) : session? deliver the directive `[hub-command] Call the tool \`X\` with arguments Y now. Then reply with a terse summary of the tool result.` and await the reply. Peer relay → op `tool` `{target, tool, args, waitMs}`. Timeout `wait_seconds*1000 + 30s`.

### hub_spawn_worker

Description: "Spawn a fresh headless OMP session (omp --mode rpc) managed by the hub. Drive it with hub_send_message / hub_call_tool."

```ts
{
  name:  z.string().optional().describe("worker name (default worker-N)"),
  model: z.string().optional().describe("model spec for the worker"),
}
```

Routing: hub-local → `AgentRuntime.spawn` via the `omp_agent` adapter (`OMP_BIN --mode rpc`, env `OMP_HUB_BRAIN=1`, `OMP_HUB_MODEL` fallback), register in `status.json` as `kind:"worker"`. Peer relay → op `spawn`. Timeout 60s. Duplicate names are rejected `{ok:false}`.

### hub_kill_worker

Description: "Dispose an RPC worker spawned by hub_spawn_worker. Kills the process and writes the archive record."

```ts
{
  name: z.string().describe("worker name"),
}
```

Routing: hub-local → `AgentRuntime.dispose` (SIGTERM, then kill), remove from `status.json`, write `archive/YYYY-MM/<name>.json` (`closedAt`, `closedBy:"hub_kill"`, final summary from the last summary/assistant line). Peer relay → op `kill`. Timeout 15s.

### hub_archive

Description: "Properly close a live session: flush state, write the archive record (closedAt, closedBy, finalSummary) and remove it from status.json."

```ts
{
  id: z.string().describe("session id prefix or title substring"),
}
```

Routing: hub-local → `resolveTarget` → close: remove from `sessions`, write `archive/YYYY-MM/<id>.json` with the full record plus `closedAt`, `closedBy:"hub_archive"`, `finalSummary` (last `summaries.jsonl` line for the session, else last `assistant_message`). Peer relay → op `archive`. Timeout 15s. This is the only way a still-running peer session leaves the roster voluntarily.

### hub_attention

Description: "List the hub's open attention items (approval, question, blocked, idle) with ids, sessions, and text. Empty result means nothing needs you."

```ts
// parameters: z.object({}) — no arguments
{}
```

Routing: hub-local → `AttentionStore.open()` — `AttentionItem[]` sorted by `createdAt`, each `{ id, sessionId, kind: approval|question|blocked|idle, text, createdAt }`. Peer relay → op `attention`. Timeout 10s.

### hub_answer

Description: "Answer an attention item: deliver the text to its session, resolve the item, and record the resolution."

```ts
{
  id:   z.string().describe("attention item id"),
  text: z.string().describe("answer delivered to the session"),
}
```

Routing: hub-local → deliver `text` to the item's session, then `AttentionStore.resolve(id, { answer })` and a `kind:"resolution"` line in `summaries.jsonl` (`{t, sessionId, kind, text, by}`). Peer relay → op `answer`. Timeout 15s. Unknown id → `{ok:false}`.

### hub_assign

Description: "Give an idle session work: deliver the task text as a user message and mark the session working."

```ts
{
  id:   z.string().describe("session id prefix or title substring"),
  task: z.string().describe("task text delivered to the session"),
}
```

Routing: hub-local → `resolveTarget` → deliver `task`, flip phase to `working`, append a `task_assigned` line to `logs/<id>.jsonl` via the `EventBus`. Peer relay → op `assign`. Timeout 15s.

### Error rules

- Every `deliver` / `sendUserMessage` call is wrapped in try/catch. A dead target or a hub fault is surfaced in the tool result (`{ok:false, text}`) — it NEVER throws into the host session. A reporting session must survive hub death, and the hub session must survive a dead peer.
- Tool timeouts resolve `{ok:false}` with the timeout text (## Reporter); they never reject.
- Inbound frames are parsed defensively: malformed JSON and unknown kinds are dropped silently.
- The reporter never writes hub files. Single-writer rule: only the hub process touches `status.json`, logs, and `summaries.jsonl`; CLI, web, and reporters read.

## Widget

Hub-mode only, driven through `setWidget("omp-hub-stream", lines)`.

DECISION — the widget renders the attention contract, not the raw stream.
WHY: the hub is action-oriented; the log stream already has dedicated surfaces (`hub log -f`, `hub watch`, the Console).
CONTRACT: hard budget of 8 lines; the renderer clips, never wraps.

Line budget:

| lines | content |
|---|---|
| 1 | orientation: `⚠ n ⏳ n 💤 n` + top attention item + hint `answer <id> …` |
| 2–6 | up to five session rows: hue bar + short id/title + phase glyph + one-line description |
| 7 | overflow (`+N more sessions` / `+N more attention items`) or the newest summary line (flash) |
| 8 (footer) | `OMP_HUB_SOCK` path (default `~/.hub/hub.sock`) + `summaries <n>` |

Counts: `⚠ n` = open attention items needing a human (kinds `approval|question|blocked`); `⏳ n` = sessions in phase `working|waiting`; `💤 n` = sessions `idle`. The hint mirrors the top `AttentionItem` — typing `answer a3f2 approved` at the hub routes through `hub_answer`. Session hue comes from the shared hash hue (lib/theme.ts), the same hue tagging the session in CLI and web rows.

Example render (6 lines — under budget):

```text
⚠2 ⏳3 💤1 · tilt: needs approval for bun add zod · answer a3f2: …
▌a3f2 tilt     ⚠ blocked  bun add zod → awaiting your approval
▌9d01 deploy   ▶ working  canary rollout 2/3
▌c44e docs     … waiting  summarizing PR notes
▌77aa scratch  💤 idle    no task
~/.hub/hub.sock · summaries 14
```

States:

| state | trigger | render |
|---|---|---|
| `idle` | no events for 30s and no open attention | orientation dimmed, rows muted |
| `busy` | events flowing | newest row's hue bar pulses; phase glyphs live |
| `attach` | `session_start` with `attached:true` arrives | that row highlights for one refresh |
| `summary-flash` | new `summaries.jsonl` line | footer count flashes; line 7 shows the summary |

Update triggers: ANY hub event (reporter frame, cmd/reply, timer tick from `Clock`) schedules a render, debounced 250 ms trailing — a burst of events costs exactly one render. `setWidget` is called only when the rendered lines actually changed (string compare), so idle hubs cost zero UI churn.

## Agent spawn

`/hub-agent` (and `hub agent`, and the Console toggle) spawn the hub's own agent through the same path as any worker:

- Child process: `OMP_BIN --mode acp`, spawned via the `AgentRuntime` port (`omp_agent` adapter), env `OMP_HUB_AGENT=1` (+ `OMP_HUB_MODEL` when set). The child is a peer session: it loads the extension normally, reports over `hub.sock`, and calls the nine tools as peer relay — minimal special casing only (## Anti-recursion guards 5–6: it may not become the hub, and its frames never raise attention).
- Registration: `status.json` record with `kind:"agent"` and `agentSurface:"watcher"` (declared surface id; surfaces register a renderer per id; default `watcher`, demo `pending`). Per-agent surface state lives at `~/.hub/agents/<name>/surface.json`.

The watcher's contract with lib — it is the thing that makes the main view:

- Consume the `EventBus` and maintain per-session `phase` (`working|waiting|idle|blocked`) + one-line `description` in `status.json` — the digest lines every surface renders.
- Append per-turn summaries to `summaries.jsonl` via `SummaryStore` (`{t, sessionId, kind:"summary"|"resolution", text, by}`).
- Raise and resolve `AttentionItem` rows via `AttentionStore` — kinds `approval|question|blocked|idle`; items resolve with `answer` + `by` when `hub_answer` fires, or get dismissed (resolved without reply) from a surface's answer flow — the resolution lands as a `kind:"resolution"` line in `summaries.jsonl` either way.

DECISION — the agent is optional, default off.
WHY: the tool must be useful with zero ceremony; `/hub-start` alone gives roster + log + relay.
CONTRACT: without the agent, surfaces hide the attention/summary rails and fall back to stream-only mode; the reporter still records everything. At most one hub agent at a time; `/hub-agent` adopts the existing one if alive.

## Shutdown

Hub `session_shutdown` teardown, in order:

1. Widget cleared (`setWidget("omp-hub-stream", undefined)`).
2. `hub.sock` server closed — connected reporters see EOF and enter reconnect backoff.
3. Workers and brain disposed (`AgentRuntime.dispose`: SIGTERM, then kill after grace).
4. Final `StatusStore` write (hub meta block updated; peer sessions left as-is).
5. Open attention items are left open — they live in `status.json`, not in the process.

DECISION — hub shutdown does NOT archive open sessions.
WHY: sessions outlive the hub; archiving them would fake-close live work. On the next `/hub-start` every reporter reconnects and announces `session_start attached:true`, and pickup is idempotent (## Reporter).
CONTRACT: `archive/YYYY-MM/<id>.json` records exist only for proper closes: `hub_kill_worker`, `hub_archive`, or a peer's own `session_shutdown` (which sends `session_end`; hub closes that one session with `closedBy:"session_exit"`). Peer rows orphaned by a lost `session_end` frame are never silently hidden — they carry `lastActivity`, so staleness is visible in every surface.

Reporter side: on its own `session_shutdown` the reporter makes one best-effort `session_end` send and stops; if the hub is already gone the frame is dropped with the outbox and the hub archives the session on cleanup or the row simply stays stale-visible. Nothing crashes: teardown is the same try/catch discipline as everything else.

## Env vars

| var | default | read by | meaning |
|---|---|---|---|
| `OMP_HUB_SOCK` | `~/.hub/hub.sock` | hub, reporter, CLI, web | hub.sock path; every surface must resolve the same value or nothing connects |
| `OMP_HUB_BRAIN` | unset | extension factory | `1` → early-return guard: this process is a driven child (brain/worker) and contributes RPC answers only |
| `OMP_HUB_MODEL` | unset | `/hub-start`, `/hub-agent`, `hub_spawn_worker` | default model spec for spawned children |
| `OMP_BIN` | `omp` | `AgentRuntime` callers | binary spawned for brain, workers, and the hub agent |
| `OMP_HUB_AGENT` | unset | extension factory | `1` → this session IS the hub agent: its frames are marked `kind:"agent"` and excluded from attention/summarize loops |

## Anti-recursion

Layered guards, cheapest first. Each is a decision with one job: the hub must never consume itself.

1. **Brain guard.** `OMP_HUB_BRAIN=1` → factory early-return before any registration (## Entry). WHY: children are driven; a child that reports or serves forks the hub forever. CONTRACT: zero `pi.on` / `registerTool` / `registerCommand` in children.
2. **Self-feed.** Hub-session events enter the local handler directly, never the socket (## Reporter). WHY: the hub consuming its own socket traffic would double-count itself and re-deliver its own output as input. CONTRACT: `hubActive && sessionId === selfSessionId` → `handleEvent`, never `sendFrame`.
3. **No self-delivery.** A `deliver` targeting `selfSessionId` is rejected at the hub (`ok:false`, "cannot deliver to the hub itself"). The hub agent answers through the `AttentionStore`, never by messaging the hub session.
4. **Attach idempotency.** `session_start` with `attached:true` for a known `sessionId` upserts in place; duplicate frames, reconnect storms, and hub restarts never duplicate roster rows or attention items.
5. **Agent sessions cannot become hubs.** `/hub-start` in a session with `OMP_HUB_AGENT=1` is refused ("this session is the hub agent"). WHY: a hub inside the hub's own agent would recurse the watcher through itself.
6. **`kind:"agent"` isolation.** Frames from `OMP_HUB_AGENT=1` sessions are recorded in logs but never trigger attention raising or summarization; the `AttentionStore` rejects items whose `sessionId` is the agent's. The watcher must not watch itself.
7. **One-hop relay, bounded waits.** The hub never re-relays a reply as a `deliver`; cmd → reply is one hop. Every wait is bounded by a per-op timeout, and the reporter outbox is capped, so a dead hub cannot grow memory inside a reporting session.
