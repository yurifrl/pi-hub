# Hub Console

The Hub Console is the `@yurifrl/hub-web` surface: a zero-framework Bun server that renders `~/.hub/` state as server-side HTML strings and keeps it live over `SSE` (`GET /stream`). It is an action-oriented renderer, not a log viewer — like the CLI board and the omp widget, it opens on **what needs you** and demotes the raw stream to a secondary panel. It reads `status.json` and `summaries.jsonl` through the same `StatusStore` / `SummaryStore` / `AttentionStore` ports the CLI uses, writes only through the hub's command surface (`answer`, `dismiss`, `assign`, `send`), and never touches the single-writer file directly: the hub process remains the only writer of `status.json`. No client-side framework, no build step, no hydration — the server renders HTML strings, the browser applies `SSE` deltas to a tiny in-memory state object. A page is a renderer plugin over the same shared domain types (`AttentionItem`, `SessionRecord`, `Summary`) every other surface consumes; nothing here parses logs or re-derives attention.

## Routes

All HTML routes render from the latest in-memory snapshot (warmed from `status.json` at boot). All API routes are JSON in / JSON out and write through the command surface. `GET /` is the attention console — the web twin of bare `hub` — and is the default landing page.

| method | path | kind | what it renders / does |
|---|---|---|---|
| GET | `/` | html | attention console: orientation line, attention cards, running strip, idle-assign cards, collapsed stream, summary rail |
| GET | `/session/:id` | html | session detail: full log (via the `status.json` log LINK), phase timeline, tool bars, pinned send box; archived flavor when the session is closed |
| GET | `/agent` | html | hub-agent surface registry; renders the page declared by the agent's `agentSurface` id |
| GET | `/archive` | html | index of closed sessions from `archive/YYYY-MM/<id>.json`, grouped by month, link to each detail |
| GET | `/archive/:id` | html | archived session detail — same renderer as `/session/:id` with archived flavor forced |
| POST | `/api/answer` | api | `{itemId, text}` — deliver text to the session, resolve the attention item; records a `resolution` line in `summaries.jsonl` |
| POST | `/api/assign` | api | `{sessionId, task}` — hand an idle session work via the command surface |
| POST | `/api/send` | api | `{sessionId, text}` — deliver a prompt to a session from the detail send box |
| POST | `/api/dismiss` | api | `{itemId}` — resolve the item without replying; also records a `resolution` line |
| GET | `/api/status` | api | current full state (same payload shape as the `snapshot` SSE event) — debug / curl / smoke checks |
| GET | `/stream` | sse | `text/event-stream`; live deltas, Last-Event-ID aware |

Route rules:

- **Archived flavor** is data-driven, not a separate template: `/session/:id` looks in open sessions first, then the archive; a closed session renders with the closed badge, close date, and final summary pinned (see Session detail). `GET /archive/:id` is the explicit entry that forces the archived flavor and 404s for ids that are not archived.
- Unknown `:id` on `/session/:id` → 404 page listing open sessions (so a stale link still lands somewhere useful). Unknown item id on any `POST /api/*` → `404 {"error": "unknown item"}`; malformed JSON body → `400 {"error": ...}`.
- `/agent` with no live hub agent renders the registry as empty-state ("no hub agent running — start with `hub agent`"), not an error.
- POSTing to a closed/archived session (`/api/send` with an archived `sessionId`) → `409 {"error": "session closed"}`; the CLI surfaces the same refusal.

## SSE contract

One endpoint, `GET /stream`, `text/event-stream`, one logical channel. Events carry `id:` fields so the client can reconnect; payloads are JSON. The server emits in hub-phase order — when something changes, the smallest event that describes the change goes out; a `snapshot` is always sufficient state on its own.

| event | payload | when |
|---|---|---|
| `snapshot` | `{v, digest, attention: AttentionItem[], sessions: SessionDigest[]}` — full attention + sessions state, same shape `GET /api/status` returns | on connect (first event), after reconnect, and after any server-side state that cannot be expressed as a delta (agent restart, archive sweep, version bump) |
| `attention` | `{op: "raised"\|"resolved", item: AttentionItem}` — raised/resolved deltas for one item | hub agent raises or an answer/dismiss resolves an item |
| `log` | `{sessionId, hue, entry: {t, kind, text}}` — one log line, `hue` precomputed server-side from the session hash so the client never hashes | every reporter line (session_start / user_message / assistant_message / tool_call / agent_end) for every open session, always — collapsed-stream clients still buffer them (see Client state) |
| `summary` | `{t, sessionId, kind, text, by}` — one `summaries.jsonl` line | hub agent writes a summary or resolution |
| `phase` | `{sessionId, phase, at}` — session moved between `working \| waiting \| idle \| blocked` | reporter phase transition or agent digest update |

Reconnect semantics:

- `EventSource` reconnects automatically with `Last-Event-ID`. The server keeps a small ring of recent event ids (per connection it tracks the last emitted id); on reattach with a `Last-Event-ID` it replays what the ring still holds and then sends a fresh `snapshot` — the client treats any snapshot as authoritative and replaces state wholesale, so replayed deltas are idempotent (deltas are keyed by item id / session id, so re-applying is safe).
- Missed-beyond-ring reattach degrades to just the snapshot refresh; that is the designed behavior — the snapshot is the contract, deltas are an optimization.
- The `snapshot` payload is the single full-state shape; `GET /api/status` returns exactly it. One shape, two transports.
- Web-package extension: `/agent` pages may also emit a `surface` delta (`{name, json}`) when a watched `~/.hub/agents/<name>/surface.json` changes (see Agent page). The five events above are the core contract every client must handle; `surface` is consumed only by custom agent pages.

## Main page

`GET /` renders top-down in this exact order — same hierarchy as the CLI board and omp widget:

1. **Orientation line** — one agent-written sentence under the header: what needs you first ("tilt needs approval · deploy canary 2/3 · docs idle 12m"). Sourced from the hub-agent `digest` field in `status.json`; when the agent is off, the server synthesizes counts ("2 need you · 3 running · 1 idle"). Updated via `phase` deltas carrying the new digest, or a fresh `snapshot`.
2. **Attention cards** (amber-bordered, `warn` token) — one per `AttentionItem`, kind-tagged (`approval` / `question` / `blocked` / `idle`). Each card: kind chip, session hue bar + session id, item text, and three verbs as first-class inline controls — the answer input lives **on the card** (type + Enter → `POST /api/answer`, delivers to the session and resolves), dismiss `✕` (→ `POST /api/dismiss`), open `→` (link to `/session/:id`). All four kinds use the same three verbs — answering a kind-`idle` item nudges its session; assigning idle *sessions* is the separate idle-assign section below.
3. **Running strip** — one digest line per active session (`working` / `waiting` / `blocked`): hue bar, phase word, agent-written description. Not the log — a digest. Each line links to `/session/:id`. A `waiting` line carries its attention count.
4. **Idle-assign cards** — one per `idle` session: hue bar, id, idle-for duration, and an "assign work" input right on the card (Enter → `POST /api/assign`).
5. **Collapsed stream** — a chip (`▸ stream (n)`); toggling expands the full hue-tagged live log (the `log` events, newest at bottom). Collapsed by default; the stream never disappears, it just stopped being the headline. Toggling sends no request — the client keeps receiving `log` events and shows/hides the panel.
6. **Summary rail** — right column, latest `summary` lines from `summaries.jsonl` (per-session tinted), newest first, each linking to `/session/:id`. `resolution` lines render inline with the answer text.

Keyboard: `a` focus next attention card input, `s` toggle stream, `/` focus filter, `Enter` submits the focused input, `Esc` blurs. Filter hides non-matching cards and strip lines (client-side only).

## Session detail

`GET /session/:id` — the full-record view; the raw log lives here, demoted from the main page but first-class quality.

- **Full log via the LINK, not embedded**: the session record in `status.json` carries `log: "logs/<id>.jsonl"` — a link, never content. The server reads that file through the store adapter per request (bounded tail + `?since=` cursor param for live tailing) and renders hue-tagged entries. The web server never inlines log bytes into `status.json` reads.
- **Phase timeline**: horizontal rail of the session's phase history from the record's bounded `phaseHistory` (`{phase, at}[]`, newest right, cap 50). Absent field → timeline shows the current phase only. `blocked` and `waiting` segments render in `warn`/`err`, `working` in `ok`.
- **Tool bars**: one compact row per `tool_call` log entry — tool name, arg digest, duration, ok/err dot. Collapsed by default per tool kind; click expands the result.
- **Pinned send box**: bottom-pinned input, always visible; Enter → `POST /api/send {sessionId, text}`; delivery state (queued → delivered) shown inline from the response.
- **Archived flavor** (closed session): closed badge, `closedAt` date, `closedBy`, and the final summary pinned above the log; the send box is replaced by a "closed — read-only" note, answer/assign controls absent. Same renderer, data-driven flavor.

## Agent page

`GET /agent` renders the hub agent's declared custom surface — the agent owns its interface.

- **Surface registry**: a static map in the web package from `agentSurface` id → renderer function. Surfaces register per id; the page looks up the agent record's `agentSurface` and hands the panel the record's fields. This is the DRY web-side expression of the surfaces contract: one registry, renderers are pure functions from agent state to HTML.
- **Default `watcher` surface**: a compact panel — digest line, attention counts (`⚠ n ⏳ n 💤 n`), last summary, cadence heartbeat. It mirrors what the CLI `hub agent --surface watcher` shows, rendered in HTML.
- **Demo `pending` surface**: renders `~/.hub/agents/<name>/surface.json` as a self-updating panel. The server watches that file (mtime poll) and pushes a `surface`-namespaced delta over the same `/stream` connection when it changes; the client re-renders the panel from the JSON payload. No client polling, no reload.
- **Unknown `agentSurface` id** → generic card: agent name, kind, digest, link to its session detail. Never a 404 — the registry degrades, it does not fail.
- The hub agent is optional (default off). With no agent, `/agent` renders the empty-state described under Routes and the main page hides attention/summary rails (fallback stream-only mode).

## Server

`@yurifrl/hub-web` exports one entry, `startHubWeb` — the composition root injects stores, bus, and command surface; the package holds no file I/O of its own beyond reading the log/surface files through injected ports. Port shape (type sketch, no imports):

```ts
type HubWebDeps = {
  port?: number;                 // default 7749 (final default owned by 03-cli), binds 127.0.0.1 only
  stores: {
    status: StatusStore;         // read status.json + sessions map
    summaries: SummaryStore;     // tail summaries.jsonl
    attention: AttentionStore;   // read/answer/dismiss attention items
  };
  bus: EventBus;                 // hub event bus; web subscribes, never publishes state
  commands: CommandSurface;      // answer / dismiss / assign / send — all writes go through here
  logs?: {                     // shape the web package needs; satisfied by injecting
    tail(id, since?): Entry[]; // the lib jsonl_store adapter — reads logs/<id>.jsonl
  };                           // via the status.json log LINK. Not a new lib port.
  theme?: ThemeTokens;           // defaults to lib/theme.ts
};
type startHubWeb = (deps: HubWebDeps) => Promise<{ stop(): Promise<void>; port: number }>;
```

- **Bind address**: `127.0.0.1` default, non-configurable in v1. The console is a window onto your local agents' session content and can answer on your behalf — it must not be reachable from the network by default.
- **Security tradeoff (v1 = local-only, no auth)**: we deliberately ship no token/session auth. Why: the hub is a single-user, same-machine tool; the socket and the web server already assume a trusted local user, and auth would add a secret-management surface (where does the token live, how does the browser get it) that outweighs the threat for v1. The tradeoff we accept: **any local process or user on the machine can read every session's log content and post answers as you**. That is exactly the trust boundary `hub.sock` already assumes (same-user unix socket), so the web surface adds no new exposure — it just makes the same assumption explicit. Mitigation that ships anyway: bind to loopback only, no CORS headers on API routes (browsers block cross-origin POSTs with JSON bodies; no `Access-Control-Allow-Origin` is emitted), `Content-Type: application/json` enforced on API responses. Future: token auth (env-provided token, required as query param on `/stream` and header on API routes) behind an explicit opt-in flag — designed but not built in v1.
- **Rendering**: server-side HTML template strings, hand-rolled, one function per page (match-day web style: small named functions, no framework, no client bundle). CSS custom properties are generated from `lib/theme.ts` tokens (`--accent: #70e1c4; --ok: #3fd68f; --warn: #f5c04e; --err: #ff7a9a; --muted: #8b97b0;` plus per-session hue variables `--hue-<sessionId>`); the theme is defined once in lib and injected here — the web package never hardcodes a hex value.
- **Static assets**: one small inline `<style>` and `<script>` per page (no separate files, no build step); CSP `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'` — inline is deliberate, the pages are served from one origin and the alternative is a build step.
- **Lifecycle**: `startHubWeb` subscribes to the bus on start, unsubscribes and closes all SSE connections on `stop()`. `hub web [--port N]` is the CLI wrapper around it.

## Client state

The client is a dumb cache with one invariant: **the snapshot is authoritative; deltas are idempotent**.

- On load: fetch `/api/status` → hold as `state` → open `/stream` → apply deltas.
- `snapshot` replaces state wholesale. `attention` deltas upsert/remove by item id (`op: "raised"` → upsert; `op: "resolved"` → remove + mark resolved in the summary rail). `log` appends to that session's stream buffer (bounded ring, oldest dropped). `summary` prepends to the rail. `phase` updates the session's phase + description.
- On reconnect (`EventSource` fires `error` then re-opens with `Last-Event-ID`): server responds with replay + fresh `snapshot`; the client replaces state on snapshot. Because deltas are keyed by id, a replayed delta after a newer snapshot is a no-op unless it carries a newer `t`.
- No client-side derived state beyond the filter query and scroll position; every render is a pure function of `state`. Rerender on each delta is fine at hub scale (tens of sessions); if the stream panel gets hot, only it re-renders.

## Wireframes

Attention console (`GET /`, stream collapsed):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ hub console                    ○ agent on        [archive] [agent]       │
│ ⚠ tilt needs approval · deploy canary 2/3 · docs idle 12m                │  ← orientation (digest)
├──────────────────────────────────────────────────────────┬───────────────┤
│ NEEDS YOU (2)                                            │ SUMMARY RAIL  │
│ ┌──────────────────────────────────────────────────────┐ │               │
│ │ ⚠ approval · tilt                    ▍(hue)  ✕  →    │ │ ▍tilt         │
│ │ rate limit hit on POST /deploy — approve retry?      │ │  needs approv │
│ │ [ approve with note ______________ ] ⏎ answers       │ │  · 2m ago     │
│ └──────────────────────────────────────────────────────┘ │ ▍canary       │
│ ┌──────────────────────────────────────────────────────┐ │  deploy 2/3   │
│ │ ? question · docs                    ▍(hue)  ✕  →    │ │  rolling ok   │
│ │ which registry for the new image?                    │ │               │
│ │ [ answer _________________________ ]                 │ │               │
│ └──────────────────────────────────────────────────────┘ │               │
│ RUNNING                                                  │               │
│ ▍tilt       working  editing deploy.ts               →   │               │
│ ▍canary     waiting  1 attention · rate limit         →  │               │
│ IDLE — assign work                                       │               │
│ ▍docs       idle 12m   [ assign: ______________ ]        │               │
│ [▸ stream (47)]                                          │               │
└──────────────────────────────────────────────────────────┴───────────────┘
  keys: a next attention · s stream · / filter
```

Session detail (`GET /session/:id`, open flavor):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▍tilt · working · started 14:02 · omp --mode acp          [← console]    │
│ phase:  working ─ working ─ waiting ─ working            (timeline)      │
│           14:02      14:07      14:09      14:12                         │
├──────────────────────────────────────────────────────────────────────────┤
│ LOG (logs/tilt.jsonl — linked, not embedded)                             │
│ ▍14:02 ▶ session_start  attached=true                                    │
│ ▍14:03 ▸ user_message   "deploy canary to staging"                       │
│ ▍14:03 ● assistant      reading deploy config…                           │
│ ▍14:04 ⚙ tool: Bash     gh api …                              ok   0.8s │
│ ▍14:05 ⚙ tool: Bash     gh api …                              err  0.4s │
│ ▍14:07 ⚠ raised approval: rate limit on POST /deploy                    │
│  …                                                            tail -f ▾ │
├──────────────────────────────────────────────────────────────────────────┤
│ TOOL BARS   Bash ×4 (2 ok · 1 err · 1 running)   Read ×11 (ok)    [▾]    │
├──────────────────────────────────────────────────────────────────────────┤
│ [ send: ______________________________ ] ⏎  (pinned, always visible)     │
└──────────────────────────────────────────────────────────────────────────┘
```

Session detail — archived flavor (closed):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▍tilt · ARCHIVED · closed 2026-08-29 18:44 by hub-cli     [← archive]    │
│ final summary: deployed canary 3/3, clean; rate limit resolved by Y.     │
├──────────────────────────────────────────────────────────────────────────┤
│ LOG (read-only)                                                          │
│ ▍14:02 ▶ session_start …                                                 │
│ ▍18:44 ■ closed (hub_archive)                                            │
├──────────────────────────────────────────────────────────────────────────┤
│ closed — read-only (no send box)                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

Agent page (`GET /agent`, demo `pending` surface):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ hub agent · surface: pending (demo)              [← console]             │
├──────────────────────────────────────────────────────────────────────────┤
│ ~/.hub/agents/<name>/surface.json              (self-updating over /stream)│
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ pending review: 3 diffs                                              │ │
│ │  ▍ tilt      +120 −4   api/deploy.ts        [review] [skip]          │ │
│ │  ▍ canary    +18  −0   lib/theme.ts         [review] [skip]          │ │
│ │  ▍ docs      +2  −22   docs/old.md          [review] [skip]          │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

Unknown `agentSurface` id → generic card:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ hub agent · surface: my-custom (unknown)         [← console]             │
│ ▍ digest: watching 3 threads · 1 needs you                               │
│ → open session                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```
