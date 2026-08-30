# Agents and skills

This doc specifies pi-hub's agent layer: the optional hub agent (the watcher),
the `agentSurface` contract any agent can own, the two package skills
(`skills/hub-ops`, `skills/hub-watcher`), the two agent files
(`agents/hub-watcher.md`, `agents/pending-agent.md`), the end-to-end
interaction flows, and the cadence and budget rules that keep the watcher
cheap. Decision-record style: decision, why, contract.

## Hub agent

**Decision.** The hub agent is optional and **default off**.

**Why.** The hub is useful without it: the reporter still records every event,
the nine `hub_*` tools still work, the log still streams. AI classification
costs model calls and can be wrong; nothing structural may depend on it. When
the agent is off, every surface falls back to raw stream-only mode and hides
the attention/summary rails — the tool still records everything.

**Contract.**

Spawning — three entry points, one path:

| entry | where | behavior |
|---|---|---|
| `hub agent [--surface watcher]` | CLI | spawns in the foreground; ctrl-c kills it |
| Agent page toggle | Hub Console (04-web) | spawns under hub supervision |
| `/hub-agent` | any omp session | plugin-registered command; delegates to the same spawn |

All three resolve to one spawn through the `AgentRuntime` port (`omp_agent`
adapter): a child `omp --mode acp` session with env `OMP_HUB_AGENT=1`,
flagged `kind:"agent"` in `status.json` like any other session, selecting the
agent file whose frontmatter declares the requested `surface:` (default
`watcher` → `agents/hub-watcher.md`; demo `pending` →
`agents/pending-agent.md`). Model via `OMP_HUB_MODEL`; omp binary via
`OMP_BIN`; remaining spawn env is the plugin's contract (05-omp-plugin).

The loop, per event batch from the `EventBus`:

1. Subscribe `EventBus`, batch events.
2. Classify per session → phase `working | waiting | idle | blocked` plus a
   one-line description.
3. Submit phase + description to the hub writer — the single writer of
   `status.json`. The agent never writes the file itself; it only submits
   updates over the control channel.
4. Write summaries (≤2 sentences per session turn) to `summaries.jsonl`.
5. Raise/resolve `attention[]` per the detection rules below.

Detection rules — event in, kind and phase out:

| observed event | AttentionItem kind | phase effect |
|---|---|---|
| tool result waiting on the user (approval prompt, permission request, confirm) | approval | waiting |
| assistant output shaped as a question to the user | question | waiting |
| tool failure the session cannot recover from alone | blocked | blocked |
| session idle past its timeout with nothing queued (Clock port) | idle | idle |
| anything else | no item raised | working |

Raise rules: one open item per (session, cause); a re-raise updates the text,
never duplicates; resolution happens when the watcher observes the user reply,
the tool proceeding, or the failure cleared — or when anyone answers via
`hub_answer`, `hub answer`, or the web console (see Interaction flows).

On restart (crash, reboot) the watcher runs one catch-up pass: it re-derives
phases from `status.json` and recent summaries, re-raises missing items from
current process state (`hub_list_sessions`), and resumes the loop. EventBus
events observed during downtime are not replayed; the catch-up pass replaces
replay.

System prompt sketch — the full text lives in `agents/hub-watcher.md`, with
the classification rubric sourced from `skills/hub-watcher`:

```text
You are the hub-watcher — the hub's own agent. You keep ~/.hub/status.json
truthful and the attention queue actionable. You never do product work.

On every event batch:
1. Attribute each event to its session.
2. Classify the session phase: working | waiting | idle | blocked.
3. Submit phase + description (<= 12 words) to the hub writer.
4. Detect attention. Raise sparingly: an item costs the user a context switch.
   - tool result waiting on the user          -> kind approval
   - assistant output shaped as a question    -> kind question
   - unrecoverable tool failure               -> kind blocked
   - idle past timeout, nothing queued        -> kind idle
5. Write one summary line per session turn to summaries.jsonl (<= 2 sentences).
6. Resolve items you see answered, proceeded, or fixed.

Rules:
- One open item per (session, cause). Re-raise updates text, never duplicates.
- Never edit product code, never run repo commands. Your writes are hub ops.
- Unsure? Leave phase "working", raise nothing. A false alarm is worse than
  a late item.
```

**Supervision.** A CLI foreground spawn dies with its terminal. Supervised
spawns (web toggle, plugin) restart on-failure with bounded backoff. While
the watcher is down, surfaces keep rendering the last known `status.json`
(durable state) marked stale; the plugin keeps recording events either way.

## agentSurface

**Decision.** An agent can own its UI: it declares an `agentSurface` id, and
hub surfaces render that surface from a state file the agent rewrites —
custom surfaces are file-backed; the bundled `watcher` surface is the one
synthesized exception (from `status.json`).

**Why.** Agents know what they want to show — a pending queue, review diffs,
a plan tree. Hard-coding each one into CLI and web duplicates the agent in two
renderers. The file is the interface: renderer plugins read it, the agent
writes it, nobody parses agent prose.

**Contract.**

1. An agent file declares `surface: <id>` in frontmatter. The hub exposes the
   id on the agent's session record in `status.json` and via
   `hub_list_sessions`.
2. Hosts register a renderer per id. Bundled renderers: `watcher` (default —
   the attention-board digest) and `pending` (demo). Registration is
   additive; a host lacking a renderer for an id renders the generic card.
3. The agent rewrites `~/.hub/agents/<name>/surface.json` — its name, its
   file, its writer. This is the deliberate per-file exception to the
   hub-only writer of `status.json`: one writer per file, and here it is the
   agent. Rewrite is atomic tmp+rename; `revision` is monotonic; the file is
   capped at 64 KB (renderers truncate sections, never fail); unknown fields
   are ignored (forward compat).
4. Unknown id, missing file, or parse failure → generic card: headline plus
   sections listed raw. A custom surface can never break a renderer it does
   not know.

Type sketches (pure domain types; placement owned by 01-architecture —
`SurfaceState` in `lib/domain/session.ts`, the registry as a port beside
`CommandSurface` in `lib/ports`):

```ts
type SurfaceSection = {
  title: string;
  lines: string[];                 // pre-wrapped, rendered verbatim
  tone?: "info" | "warn" | "err";  // maps to theme tokens; default info
};

type SurfaceState = {
  agent: string;        // agent name; must match the owning ~/.hub/agents/<name>/
  surface: string;      // declared agentSurface id ("watcher", "pending", ...)
  revision: number;     // bumped on every rewrite; stale-read detection
  updatedAt: string;    // ISO-8601; renderers mark stale past 5 min
  headline?: string;    // the one line the renderer leads with
  sections?: SurfaceSection[];
};
```

```ts
interface SurfaceRenderer {
  readonly id: string;  // matches SurfaceState.surface
  render(state: SurfaceState): string;  // host-agnostic payload (ANSI / HTML / widget lines)
}

interface SurfaceRegistry {
  register(renderer: SurfaceRenderer): void;
  render(id: string, state: SurfaceState): Result<string, SurfaceError>;
  has(id: string): boolean;
}
```

`Result` is the core error model type from 01-architecture. The built-in
`watcher` renderer is the one exception to the file rule: it synthesizes its
`SurfaceState` from `status.json` (attention items, phases, summaries), so
the hub agent is useful with zero extra writes — the default surface needs no
file because `status.json` already carries its state. Every custom surface
(`pending` and beyond) is file-backed.

## Skills

**Decision.** Two package skills live in `skills/` at the package root
(match-day convention: one directory per skill, `SKILL.md` uppercase, YAML
frontmatter `name` + `description`): `skills/hub-ops` for any agent in any
session, and `skills/hub-watcher` as the watcher's system-prompt source.

**Why.** The `hub_*` tools are only as good as the judgment around them.
hub-ops teaches any session to operate the hub without stepping on it (when
to raise vs answer, how to summarize); hub-watcher encodes the classification
rubric once, so the agent file stays thin and the rubric is reviewable as a
skill rather than buried in a prompt.

### skills/hub-ops/SKILL.md

Purpose: for ANY agent in ANY session — worker, subagent, or human-driven —
how to use the `hub_*` tools correctly.

```yaml
---
name: hub-ops
description: >-
  Operating the hub from inside any session with the hub_* tools: list,
  send, call_tool, spawn, kill, archive, attention, answer, assign.
  Covers when to raise vs answer, and summary style. Trigger when a hub_*
  tool is available or the user mentions the hub.
---
```

Contents sketch:

- The nine tools, one rule each: `hub_list_sessions` (read state, never
  guess); `hub_send_message` (deliver a prompt; `wait_seconds` for
  round-trips); `hub_call_tool` (run a tool in another session; never
  fabricate a result); `hub_spawn_worker` / `hub_kill_worker` (lifecycle;
  kill is confirm-grade); `hub_archive` (proper close — the only path to the
  archive); `hub_attention` (list open items); `hub_answer` (answer + resolve
  someone's item); `hub_assign` (hand an idle session work).
- When to raise vs answer: you never raise attention items for your own
  session — your reporter events plus the watcher do that. You answer with
  `hub_answer` only when you hold the context to act; otherwise leave the
  item for the user.
- Summary style: when contributing a summary, ≤2 sentences, action-oriented
  ("deploy canary 2/3; waiting on approval"), never a narration of tool
  output.
- Availability rule (match-day pattern): if a `hub_*` tool is not available,
  say so and stop — never shell the `hub` CLI as a substitute, never
  fabricate a tool call that does not exist.

### skills/hub-watcher/SKILL.md

Purpose: the watcher's system-prompt source. `agents/hub-watcher.md` stays
thin (role + tools) and appends this skill.

```yaml
---
name: hub-watcher
description: >-
  System prompt source for the hub agent: the classification rubric for
  phases (working | waiting | idle | blocked) and attention kinds
  (approval | question | blocked | idle), summary style, and resolution
  recording. Loaded by the watcher; not for user sessions.
---
```

Contents sketch:

- Phase rubric: `working` (events flowing, no user wait) | `waiting`
  (approval or question raised) | `idle` (timeout, nothing queued) |
  `blocked` (unrecoverable failure).
- Attention kinds rubric: the detection table from Hub agent, plus
  counter-examples — do NOT raise for routine tool output, questions the
  session answered itself, or recoverable retries.
- Summary style: max 1 summary per session turn, ≤2 sentences, present
  tense, name the next expected event.
- Resolution recording: append a `kind:"resolution"` line to
  `summaries.jsonl` (`{t, sessionId, kind, text, by}`), keyed by the
  attention id; recording is idempotent — a second resolution of the same id
  is a no-op.

## Agent files

**Decision.** Agent personas live in `agents/` at the package root
(match-day pattern): one markdown file per persona, YAML frontmatter, body =
system prompt. Two files ship: `agents/hub-watcher.md` and
`agents/pending-agent.md`.

**Why.** Spawnable personas as data, not code: the host validates the file's
frontmatter at spawn time, applies its tools/auto-exit policy for that launch
only, and no file is copied, symlinked, or installed.

### agents/hub-watcher.md

Role: the hub's own agent — classify, summarize, raise/resolve. Read-only on
the world; its writes are hub ops.

```yaml
---
name: hub-watcher
description: "Hub agent. Classifies sessions, maintains phase + attention, writes summaries. Read-only on the world; writes only hub ops."
kind: agent
surface: watcher
tools: read, grep, hub_list_sessions, hub_attention
model: ${OMP_HUB_MODEL}
auto-exit: false
system-prompt: append skills/hub-watcher
---
```

- Tools are exactly read + the two list/attention reads. No send/assign: a
  watcher that prompts sessions crosses from observing into driving. No
  `edit`/`write`: it must not touch product code. Raising and resolving
  attention goes through the hub writer (the control-channel `attention` op,
  frame shapes in 02-data-contracts), not through filesystem tools.
- `model: ${OMP_HUB_MODEL}` — a small fast model is the expected choice;
  unset falls back to the session default.
- `auto-exit: false` — the watcher is long-lived.
- `system-prompt: append skills/hub-watcher` — the rubric lives in the skill,
  keeping this file a thin role shell.

### agents/pending-agent.md

Role: demo agent owning a custom surface — a visible "what I'll do next"
queue maintained by the agent itself.

```yaml
---
name: pending-agent
description: "Demo agent owning the pending surface: maintains its next-step queue in surface.json. Proves the agentSurface contract end to end."
kind: agent
surface: pending
tools: read, grep, write, hub_list_sessions, hub_send_message
auto-exit: false
---
```

- `kind: agent`, `surface: pending`.
- Maintains `~/.hub/agents/pending-agent/surface.json`: headline plus one
  section per pending step, `tone: warn` on the step it is about to take.
  `write` is for that one file only — the skill body pins it — which is what
  makes the file contract real rather than aspirational.
- Its interface IS the file contract: no bespoke UI code anywhere. The
  registered `pending` renderer just renders the file; a surface without
  that renderer shows the generic card. Either way the agent ships its UI by
  writing JSON — proof that a third-party agent can own a surface with zero
  hub-side code changes.

## Interaction flows

Text sequence diagrams. Notation: numbered steps, `->` is a request or
transition, comments after `#`.

### User answers an attention item

Four entry paths, one outcome; resolution is recorded first (instant UI
feedback on every surface), delivery second.

```text
answer  (user -> session)
  entries:
    hub answer <item> <text>     # CLI: command or inline board-row input
    POST /api/answer             # web: answer input on the attention card
    hub_answer(id, text)         # omp widget: the hub session's agent answers
    hub_answer(id, text)         # another agent, per skills/hub-ops rules
  1. host   -> hub.sock: cmd answer {cmdId, item, text}
  2. hub    -> AttentionStore.resolve(item, text)   # answer + resolvedAt; idempotent
  3. hub    -> session: sendUserMessage(text)       # user_message frame; session resumes
  4. hub    -> summaries.jsonl kind:"resolution"    # once, keyed by item id
  5. hub    -> surfaces: item leaves the board      # next poll / SSE push
  delivery failure -> watcher re-raises kind blocked ("answer delivery failed")
                      # update, never duplicate
```

### Agent raises an item

```text
raise   (session -> attention queue)
  1. plugin reporter -> hub.sock: session_start / user_message / assistant_message /
     tool_call / agent_end frames   # attached flag on session_start; spawned too
  2. hub -> EventBus: event batch
  3. watcher: classify session -> phase + description, submitted to the hub writer
  4. watcher: detection rules -> raise AttentionItem (one per (session, cause))
  5. hub (single writer): append to status.json attention[]; set session phase
  6. surfaces: amber item (#f5c04e) + updated orientation line on next snapshot
```

### Idle assign

```text
assign  (user -> idle session)
  1. Clock: session idle past its timeout -> watcher raises kind idle, phase idle
  2. user entry: board `assign:` input / hub_assign(id, task) / POST /api/assign
  3. host -> hub: cmd assign {id, task}
  4. hub -> session: sendUserMessage(task)      # idle item resolved, recorded once
  5. watcher: phase = working on the next batch # description becomes the task
```

### Archive close

```text
archive (close a session properly)
  1. entry: hub_archive(id) tool / CLI kill confirm / session exits cleanly
  2. hub: resolve every open attention item of the session   # recorded, no answers
  3. hub: finalSummary = last summary line for that session
  4. hub (single writer, atomic tmp+rename):
       remove the session from status.json sessions
       append a link to status.json archived[]
       write archive/YYYY-MM/<id>.json {record, closedAt, closedBy, finalSummary}
  5. surfaces: session leaves running/idle strips; detail view switches to archive flavor
```

## Cadence

**Decision.** Event-driven with tight budgets: the watcher reacts to events,
never polls the filesystem, and its per-turn output is capped.

| trigger | watcher action | budget |
|---|---|---|
| `agent_end` (per session) | re-summarize + attention scan | trailing debounce 2 s per session (Clock); max 1 summary per turn, ≤2 sentences |
| tool result waiting on the user | raise approval, phase waiting | immediate; 1 item per cause |
| assistant output question-shaped | raise question, phase waiting | immediate; 1 item per cause |
| tool failure | raise blocked, phase blocked | immediate |
| idle timeout (Clock) | raise idle, phase idle | once per idle episode |
| answer observed (any path) | resolve + resolution line | idempotent by attention id |

Rules:

- Max 1 summary per session turn, ≤2 sentences, action-oriented; appended to
  `summaries.jsonl` as `{t, sessionId, kind: "summary", text, by}`.
- The attention scan runs on waiting/failure tool results and on `agent_end`
  — never on every event. Classification is one pass per event batch, not
  per event.
- Resolution is recorded once: the `kind:"resolution"` line is keyed by the
  attention id; re-resolving the same id is a no-op (guarded in both the
  watcher and the hub writer).
- Debounce is per session, so a burst in one session collapses to one pass;
  sessions stay independent.
- While the watcher is down nothing is written and nothing is lost:
  `status.json` and `summaries.jsonl` keep their last state, and the
  restart catch-up pass covers the gap.
- The watcher itself stays cheap: model via `OMP_HUB_MODEL` (small and fast
  beats frontier here), restart on-failure with bounded backoff, and no
  polling loops — the Clock port provides the only timers (idle timeout,
  summary debounce).
