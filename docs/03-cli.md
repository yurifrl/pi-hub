# hub CLI

Spec of the `hub` binary — `@yurifrl/hub-cli`, sources under `cli/src/`. The CLI is the terminal surface of pi-hub: the attention board, one-shot verbs, and the full-screen console. Data shapes and hub.sock frames are owned by `02-data-contracts.md`; theme ownership and layering by `01-architecture.md`; the web counterpart by `04-web.md`. Decision records use **Decision / Why / Contract**. Session display name = worker `name` if present, else the first 8 chars of `sessionId`.

## bin

**Location and role.** `cli/src/bin.ts` is the composition root of `@yurifrl/hub-cli` (package `bin` field maps `hub` → `cli/src/bin.ts`, run with Bun). It parses argv, loads config, builds the commander program, and maps every failure to an exit code. Each subcommand lives in `cli/src/commands/<name>.ts` exporting a registrar; interactive rendering lives in `cli/src/tui/` (## Rendering). bin.ts contains no rendering and no domain logic.

**Commander tree.**

```text
hub
├─ (bare)                        attention board (interactive)
├─ answer <item> <text...>       reply to an attention item, resolves it
├─ assign [id] <task...>         give a session work
├─ log [-f] [id]                 raw session stream
├─ summaries [id] [--tail N]     AI summary rail
├─ send [id] <msg...>            deliver a prompt to a session
├─ tool <id> <tool> [json]       run a tool inside a session (--wait S)
├─ spawn [--name N] [--model M]  spawn a worker session
├─ kill <id> [--yes]             close a session (red confirm)
├─ archive [id]                  list the archive / close+archive a session
├─ watch                         full-screen split console
├─ agent [--surface S]           start the hub agent
├─ ping                          side-effect-free liveness probe (exit 0 live / 2 dead)
├─ sessions                      machine-wide omp inventory (roster ∪ transcripts)
└─ web [--port P]                serve the Hub Console
```

Global flags, accepted before or after any subcommand: `--config <path>`, `--json`, `--ndjson`, `--no-color`, `-h/--help`, `-V/--version`. `--json` together with `--ndjson` → usage error, exit code 1. Help and version never open the socket.

**Config.** Resolution order, first hit wins:

1. `--config <path>` file (path missing or unreadable → usage, exit 1)
2. environment (`OMP_HUB_SOCK`, `OMP_HUB_MODEL`, `OMP_BIN`, `NO_COLOR`)
3. `~/.hub/config.json` (absent file is not an error)
4. built-in defaults

```types
interface HubCliConfig {
  sock: string            // default ~/.hub/hub.sock; env OMP_HUB_SOCK
  dataRoot: string        // default ~/.hub
  replyTimeoutMs: number  // default 10000; expiry maps to exit code 3
  webPort: number         // default 4820
  spawnModel: string      // default --model; env OMP_HUB_MODEL
  ompBin: string          // default "omp"; env OMP_BIN
  color: boolean          // default true; false when NO_COLOR set or --no-color
}
```

**Boot sequence.** parse argv → resolve config → select output policy → dispatch:

- *Hub-backed commands* (`answer`, `assign`, `send`, `tool`, `spawn`, `kill`, `archive <id>`, `agent`, plus the data feeds of the bare board and `watch`): open hub.sock at `config.sock`, write one cmd frame `{ v: 1, cmdId, op, args }`, await the reply frame with the matching `cmdId` up to `replyTimeoutMs`, then close (board and watch hold the connection open for their lifetime). Version mismatch or malformed handshake → exit 2.
- *Read-only commands* (`log`, `summaries`, archive listing, picker data): read `~/.hub` files directly — `logs/<id>.jsonl`, `summaries.jsonl`, `archive/YYYY-MM/*.json`, `status.json`. No socket needed; they work while the hub is down because the data is on disk.

- **Decision:** the CLI reads files directly for reads and goes through hub.sock for every mutation. **Why:** the single-writer rule — only the hub process writes status.json — and reads gain nothing from a server round-trip. **Contract:** the CLI never writes under `~/.hub`; it never derives session state from anywhere but status.json and the jsonl files; every state change travels as a cmd frame from the locked ops list in `02-data-contracts.md`.

**Exit codes (summary; full table in ## Exit codes).** `0` ok · `1` usage · `2` unavailable-hub · `3` timeout.

## hub (bare)

Bare `hub` opens the **attention board**: the terminal rendering of status.json's `attention[]` and `sessions` map, kept live. It answers one question on open — *what needs me?* — and lets you act without leaving the screen.

**Layout**, top to bottom:

1. **Orientation line** — `hub · <n> sessions · <n> agent · <sentence>`. The sentence is the hub agent's one-liner stored in the hub meta block of status.json (field `orientation`). With the agent off the line degrades to the mechanical counts only.
2. **⚠ NEEDS YOU** — one block per AttentionItem, all four kinds (`approval | question | blocked | idle`), oldest first. Kind badge colors: approval `warn`, question `accent`, blocked `err`, idle `muted`. Row: `▎<kind> <session> <text>`; the focused item adds an inline input line `› ` with a block cursor. Typing appends; ⏎ delivers the text to the item's session through the same wire path that backs the `hub_send_message` tool (cmd frame `send`) and resolves the item server-side (`resolvedAt` + `answer` set, a `kind:"resolution"` line appended to summaries.jsonl); esc cancels.
3. **⏳ RUNNING** — one digest line per session in phase `working` or `waiting`: `▎● <name> <phase> <description> (<age>)`. `working` renders in `ok`, `waiting` in `warn`. The description is the hub agent's per-session digest; agent off → excerpt of the last tool_call or message.
4. **💤 IDLE** — one row per session in phase `idle`: `▎○ <name> idle <age>  assign: _`. Each row owns an inline assign input; typing + ⏎ issues cmd frame `assign {id, task}` and the session flips to `working`.
5. **Footer** — one muted keys-hint line.

An idle-phase session may also carry an `idle` AttentionItem raised by the hub agent ("api idle 30m — assign or kill"). Both surfaces stay: NEEDS YOU answers "what needs me", IDLE answers "what is free".

**Keys.**

| key | action |
|---|---|
| ↑ / ↓ | move focus across interactive slots (attention items, then idle assign inputs) |
| any printable | start the inline input on the focused slot (answer for items, assign for idle rows) |
| ⏎ | commit the input (cmd frame `send` or `assign`); the item resolves; focus advances |
| esc | cancel the open input |
| d | dismiss the focused attention item — resolve without replying |
| a | jump focus to the first idle row's assign input |
| ← / → | move the cursor inside an open input |
| ⌫ | delete the character before the cursor |
| o | open the focused session's full log view (same surface as `hub log <id>`, scrollable + following); `q` returns to the board |

- **Decision:** dismiss is cmd frame `attention` with args `{ action: "dismiss", id }`; the plain listing is `attention` with no action field. **Why:** the locked ops list (`list/send/tool/spawn/kill/attention/answer/assign`) has no dismiss op, and `answer` with empty text would be indistinguishable from a dropped reply. **Contract:** frame ownership sits in `02-data-contracts.md`; this doc fixes only the args shape above.

**Calm / empty variant.** When `attention[]` is empty and no session is `idle`: the orientation sentence renders in `ok` with the agent's all-clear wording, the ⚠ and 💤 zones collapse to a single muted `(empty)` line each, and the footer trims to `l log · q quit`. The board never renders empty section chrome or orphaned separators.

**Refresh.** The hub forwards its EventBus events (port ownership in `01-architecture.md`) to attached CLI connections as push frames; each one is a re-render trigger. Where a hub build does not push, a 2s fallback tick re-issues the `attention` cmd and re-reads status.json. Every reply frame the CLI receives also triggers a re-render. Frames are diffed by the screen buffer, so a no-change tick writes nothing.

**Machine modes.** `hub --json` / `hub --ndjson` skip the alt-screen and print one static snapshot envelope: `data: { orientation, attention: AttentionItem[], running: DigestLine[], idle: SessionRef[] }` (ndjson: the same object on one line). Identical rule for `watch --json`.

## Subcommands

Shared conventions:

- Trailing `<text...>` / `<task...>` / `<msg...>` args join with single spaces — prompts may contain anything, no shell-quoting traps.
- `<item>` / `<id>` accept unique prefixes; an ambiguous prefix → `error.code "ambiguous"` with the candidates in `detail`, exit 1. No match → `"not_found"`, exit 1.
- Machine modes never prompt, never enter alt-screen, never emit ANSI.
- Each command's `--json` prints exactly one `{type:"snapshot",...}` envelope; `--ndjson` prints one line per event (most commands emit exactly one line; `log -f` and `watch` stream).
- Error envelopes go to stdout and exit per ## Exit codes.

**`hub answer <item> <text...>`** — reply to an attention item. Sends cmd frame `answer {id, text}`; the hub delivers `text` to the item's session and resolves the item.
- Flags: globals only.
- Human: `✓ answered <item> → <name>` in `ok`, the delivered text echoed muted.
- `--json`: `{type:"snapshot", data:{answered:true, id, sessionId}}`; `--ndjson`: same, one line.
- Errors: unknown/ambiguous item → 1; hub unreachable → 2; reply timeout → 3.

**`hub assign <id> <task...>`** — give a session work. Cmd frame `assign {id, task}`; sets the session task and flips phase to `working`.
- `<id>` optional → fuzzy arrow picker over **idle** sessions only — assign means giving free capacity work (same component as `send`). Picker requires a TTY on stdin; without one → usage, exit 1.
- Human: `✓ assigned to <name> — <first line of task>`.
- `--json`: `{type:"snapshot", data:{assigned:true, id, sessionId, task}}`.
- Errors: as `answer`; picker over zero candidates → `not_found` 1.

**`hub log [-f] [id]`** — the raw stream of a session: demoted from headline to secondary view, still first-class quality. Reads `logs/<id>.jsonl` directly, no socket.
- `<id>` optional → picker over open sessions (reads status.json). `-f` follows: print appended lines, survive truncate/rotate, ctrl-c exits 0.
- Human: each entry as `▎<hue> <HH:MM:SS> <kind> <text>`; the hue bar is colored by session-hue; `kind` is the entry frame kind (user_message / assistant_message / tool_call / agent_end). Long lines wrap aligned under the text column.
- `--json` (no `-f`): one envelope `{type:"snapshot", data:{sessionId, entries: LogEntry[]}}`. `--json` with `-f` → usage, exit 1 (use `--ndjson`). `--ndjson`: one envelope line per entry; with `-f`, new lines stream forever.
- Errors: unknown session → 1; session open but log file absent → 1 with hint `no entries yet`. Never exit 2 — this command needs no hub.

**`hub summaries [id] [--tail N]`** — the AI summary rail. Reads summaries.jsonl directly; `<id>` filters to one session.
- `--tail N`: last N lines, default 20; `N < 1` (including `--tail 0`) → usage, exit 1.
- Human: rows `▎<muted time> <by> <text>`; `kind:"summary"` rows render `warn`, `kind:"resolution"` rows render `ok`.
- `--json`: `{type:"snapshot", data:{lines: SummaryLine[]}}`; `--ndjson`: one line per row.

**`hub send [id] <msg...>`** — deliver a prompt. Cmd frame `send {target, text}`.
- `<id>` optional → **fuzzy arrow picker** (sketch 4): type to filter across name, id, and description; ↑↓ move; ⏎ selects; esc cancels. If `<msg>` is omitted too, a second inline input asks for the message after selection.
- Human: `✓ sent to <name>`; `--json` / `--ndjson`: `{type:"snapshot", data:{sent:true, sessionId, text}}`.
- Errors: picker without TTY → 1; hub unreachable → 2; timeout → 3.

**`hub tool <id> <tool> [json]`** — run a tool inside a session. Cmd frame `tool {target, tool, args}`.
- `[json]`: optional JSON argument parsed strictly; parse failure → usage, exit 1, with the parse error in the message. Objects, arrays, and scalars pass through as `args`.
- Wait: `--wait <seconds>` bounds the tool call (default 30); the reply budget is `max(replyTimeoutMs, wait × 1000)`.
- Human: result card — header `▎tool <tool> → <name>`, body pretty-printed result truncated at 50 lines with a muted `… N more` footer.
- `--json`: `{type:"snapshot", data:{ok, result}}` with the tool result verbatim; `--ndjson`: the same snapshot on one line.
- Errors: tool unknown on the target → reply error envelope, exit 1; budget exhausted → 3.

**`hub spawn [--name N] [--model M]`** — spawn a worker session. Cmd frame `spawn {name?, model?}`.
- `--name` omitted → the hub picks `worker-<n>`; `--model` omitted → `config.spawnModel` (env OMP_HUB_MODEL).
- Human: `✓ spawned <name> (model <M>)`; `--json` / `--ndjson`: `{type:"snapshot", data:{name, model, sessionId}}`.
- Errors: name already live → reply error, exit 1; spawn failure reported by the hub (bad OMP_BIN) → 2.

**`hub kill <id>`** — close a session properly. Cmd frame `kill {name}`; the hub ends the session, writes the full record to `archive/YYYY-MM/<id>.json` with `closedAt`, `closedBy`, `finalSummary`, and removes it from status.json.
- Human: confirm prompt rendered in `err`: `kill <name>? [y/N]` — default N; anything but `y`/`Y` aborts with exit 0 and no changes. `--yes` skips the prompt. Machine modes and non-TTY stdin never prompt and never assume consent: without `--yes` the invocation is a usage error, exit 1.
- Human success: `✓ killed <name> — archived to archive/YYYY-MM/<id>.json`.
- `--json` / `--ndjson`: `{type:"snapshot", data:{killed:true, id, archivedTo}}`.
- Errors: unknown session → 1; hub unreachable → 2.

**`hub archive [id]`** — two modes. **List** (no `<id>`): read-only listing of `archive/YYYY-MM/*.json`, no socket. **Close** (`<id>`): cmd frame `archive {id}`; the hub closes the live session exactly like `kill` but records `closedBy:"archive"`.
- List human: table `id · closedAt · closedBy · finalSummary (first 60 chars)`, newest first. `--json` / `--ndjson`: `{type:"snapshot", data:{entries: ArchiveEntry[]}}`.
- Close human: `✓ archived <id>`; `--json`: `{type:"snapshot", data:{archived:true, id, path}}`.
- Errors: close → as `kill`; unreadable archive dir → 1 with the path in the message.

**`hub watch`** — the full-screen chat console (alt-screen): **a resizable sessions rail on the left, the selected session's conversation on the right**, a compose row and a key/notice footer below (sketch 3). The rail lists **every session on the machine** — the hub roster first (`⚠` needs you, `▶` working, `?` waiting, `○` idle, `✖` blocked, `·` closing), then archived (`■`) and log-only (`□`) extras, newest first, capped at the 200 most recent log files. Names come from each session's omp transcript title, falling back to the cwd basename, then the id prefix. The chat shows user/assistant messages as `time who` headers with indented bodies; tool calls are one muted `▶ tool arg` line each — adjacent identical rows (tool retries) collapse to `×N`; empty system rows are dropped. An open attention item for the selected session is pinned above the compose row. Extras are read-only: hub log first, and sessions that never got one (the hub was down) fall back to their translated omp transcript.
- Keys: `↑↓`/`Tab` select a session (extras included), `1-9` jump to the nth, `⏎` focus the compose row, `PgUp`/`PgDn` scroll the chat, `f` cycles the chat filter `all → user → assistant → tool`, `<`/`>` shrink/grow the rail between 14 and 60 cells, `d` dismiss the selected session's open attention item, `q`/`ctrl-c` quit (in compose: `esc` returns to the rail). Typing in compose edits a draft with `←/→/⌫`; `⏎` on a non-empty draft sends it — as the **answer** to the session's open attention item when there is one, otherwise as a plain message to the session.
- Machine modes: static snapshot (selected session's last chat lines + attention items), no alt-screen.
- Errors: hub unreachable while open is a rendered state, not a crash — the header shows `(hub offline)` muted, the chat keeps working from `logs/*.jsonl`; exit happens only on `q`.
- **Decision:** `watch` degrades instead of failing on hub loss. **Why:** it is a viewer; killing the console because the hub restarted would destroy the operator's context. **Contract:** a send or answer attempted while offline produces an inline `err` notice in the footer, never a process exit.

**`hub agent [--surface S]`** — start the hub's own agent: an `omp --mode acp` child via the omp_agent adapter, env `OMP_HUB_AGENT=1`, recorded with `kind:"agent"` in status.json.
- `--surface S`: writes `~/.hub/agents/<name>/surface.json` declaring the `agentSurface` id (default `watcher`; demo surface `pending`). Surface ownership in `06-agents-and-skills.md`.
- Human: `✓ hub agent started (surface watcher)`; `--json` / `--ndjson`: `{type:"snapshot", data:{started:true, name, surface}}`.
- Errors: agent already running → reply error envelope `busy`, exit 1, hint `hub kill <name>`; `omp` binary missing per OMP_BIN → 2.

**`hub ping`** — side-effect-free liveness probe for scripts (docs/07 §Run probe). One cmd/reply round-trip, op `ping`, no state touched; safe to call in wait loops.
- Human: `pong`; `--json` / `--ndjson`: `{type:"snapshot", data:{pong:true}}`.
- Exit 0 with a live hub. No hub / refused connect → `unavailable-hub` → 2. No reply before the deadline → 3.

**`hub web [--port P]`** — serve the Hub Console (`@yurifrl/hub-web`); routes and SSE are owned by `04-web.md`.
- `--port P` defaults to `config.webPort` (4820); binds `127.0.0.1` only. Opens the browser on start; with non-TTY stdout it prints the URL and skips opening. Runs foreground; ctrl-c exits 0.
- `--json` / `--ndjson` → usage, exit 1: a server has no snapshot semantics.
- Errors: port busy → 2 with the port in the message.

**`hub serve`** — a standalone hub: binds the socket, serves ops, runs until signaled. The manager path for `bridge/run` (docs/07 §Run) — no omp session hosts it. Composes `createHubLocal` (extensions/hub_local.ts) with `serveBrain: false`: no brain child, no widget; `agent` op fails with `unavailable-hub` (no omp runtime backs it). Socket path from `OMP_HUB_SOCK` (or `--config sock`); SIGINT/SIGTERM stop the socket and exit 0.
- Human: `hub serving on <socket path>` on stdout.
- `--json` / `--ndjson` → usage, exit 1: a server has no snapshot semantics.
- Errors: hub already live on the socket (handshake refused / bind refused) → 2.

**`hub tails`** — the transcript-tail bridge: feeds the hub sessions that cannot report themselves. Reads `~/.omp/agent/sessions/*/*.jsonl` incrementally and translates transcript lines into reporter frames over `hub.sock` (`client:"backfill"`), so pre-plugin omp sessions appear on the board like any other peer. Watch-me-not-mine: one file scanner + one incremental reader per transcript; no transcript mutation.
- State persists in `~/.hub/tails-state.json` (offsets + session ids); restarts resume offsets and re-announce only non-ended sessions (attach-on-connect, same contract as the plugin reporter). Discovery at boot only picks up transcripts touched since process start — dead history is never announced.
- Turn semantics: `session_start` on discovery; `user_message` / `assistant_message` / `tool_call` per transcript line; `agent_end` when a transcript goes quiet `40s` after activity (re-arms on the next line). Ended sessions are not re-announced after a hub restart.
- Human: `tails: watching <dir> → <sock> (quiet-end 40s)`; runs foreground, ctrl-c exits 0. Hub down at boot or mid-run is a retry loop (`hub unreachable — retrying every 2s`), never an exit.
- `--json` / `--ndjson` → usage, exit 1: a bridge has no snapshot semantics.

**`hub sessions`** — machine-wide omp inventory (docs/02 §Sessions op): the roster (`hub list` shape) merged with every omp transcript on the machine the plugin never reported. Cmd frame `sessions {}`.
- Human: rows `id · title · cwd · model · status`; transcript-only peers show `detached`; ids whose transcripts went quiet 40 s print under a muted `detached (quiet)` tail instead of a row.
- `--json` / `--ndjson`: `{type:"snapshot", data:{sessions, detached}}` — rows verbatim from the op reply; `errors[]` renders as muted warnings on stderr in human mode.
- Errors: hub unreachable → 2; scan failed on the hub → reply error envelope, exit 2 (roster-only fallback is the hub's concern, not the CLI's).

## Rendering

Interactive rendering lives in `cli/src/tui/`; one-shot output goes through `cli/src/paint.ts`. Commands never emit ANSI themselves — commands produce data, renderers produce frames.

**Theme → ANSI.** `lib/theme.ts` is the single token definition (ownership in `01-architecture.md`); the CLI maps each token to escape sequences:

| token | hex | ANSI truecolor | semantics in the CLI |
|---|---|---|---|
| accent | `#70e1c4` | `38;2;112;225;196` | chrome, selection, cursor, question badge |
| ok | `#3fd68f` | `38;2;63;214;143` | running, ✓ confirmations, resolutions |
| warn | `#f5c04e` | `38;2;245;192;78` | attention badges and borders, waiting, summaries |
| err | `#ff7a9a` | `38;2;255;122;154` | blocked, kill confirm, errors |
| muted | `#8b97b0` | `38;2;139;151;176` | timestamps, ids, hints, footers |

Fallback chain: truecolor → nearest 256-color cube entry → bold/plain. `--no-color` or `NO_COLOR` in the environment makes every token function return empty prefixes. Machine-mode output never carries ANSI regardless of flags.

**Session hue.** `session-hue = hash(sessionId) mod 216`, rendered as cube index `16 + h` — the 6×6×6 cube, skipping the 16 base terminal colors. Every line belonging to a session is prefixed with a two-cell bar `▎` in that hue: board rows, log lines, picker rows. **Decision:** the hue derives only from `sessionId`, never from the name. **Why:** names change (`worker-3` renamed), ids do not; the bar must keep tracking the session across every surface. **Contract:** `04-web.md` uses the identical hash so CLI and web agree on a session's color.

**Alt-screen lifecycle.** The board, `watch`, the full log view (via `o`), and pickers enter alt-screen (`smcup`), hide the cursor while a frame is stable, and restore the terminal on every exit path — `q`, ctrl-c, error, crash (an exit hook re-issues `rmcup` and shows the cursor). `log -f` in a TTY does not use alt-screen: it prints scrolling lines with tail semantics; ctrl-c exits 0.

**Re-render triggers.** EventBus push frames over the socket, every reply frame, the 2s fallback tick, and keypresses. Frames pass through the diffing buffer; a frame with zero diffs writes nothing.

**Interactive surfaces — `cli/src/tui/` on `@opentui/core`.** Board, `watch` and pickers are built on OpenTUI (Bun-native, no React). OpenTUI owns the cell buffer, diffing, alt-screen enter/leave, raw mode, key decoding and terminal restoration; the CLI owns layout and state.

- `tui/rows.ts` — attention and session row layout: zone stack, focus slots, calm-variant collapse.
- `tui/watch_view.ts` — `watch` rail and conversation view.
- `tui/picker.ts` — fuzzy arrow picker shared by `send`, `assign`, `log`.
- `tui/keys.ts` — key decoding to the logical keys the surfaces use (char, up, down, enter, escape, backspace, left, right, ctrl-c).
- `tui/colors.ts`, `tui/footer.ts` — theme-token and session-hue colors; footer hints.
- `paint.ts` — plain styled text for one-shot human output (no OpenTUI).

**Raw-mode single keypress.** While a board-family surface is open, ctrl-c arrives as a key (`q`-equivalent), not a signal; unknown multi-byte sequences are ignored and never leak as text. Non-TTY stdin skips raw mode: keys disabled, render-only.

**TTY degradation.**

| stdout | stdin | behavior |
|---|---|---|
| TTY | TTY | full interactive board / watch / picker / confirm |
| TTY | pipe | renders with inputs hidden, footer shows `(piped stdin — keys off)` |
| pipe | any | board, watch, and `log -f` render one static frame plus muted hint `run hub in a terminal for live view`, then exit 0 |
| pipe | any, `--json` / `--ndjson` | envelope output, unaffected by TTY-ness |

## Output policies

**Envelope.** All machine output is exactly one of:

```types
type OutputEnvelope =
  | { type: "snapshot"; data: unknown }
  | { type: "error"; error: { code: ErrorCode; message: string; detail?: unknown } }

type ErrorCode =
  | "usage"        // exit 1 — bad args, parse failures
  | "not_found"    // exit 1 — unknown id/item
  | "ambiguous"    // exit 1 — prefix matched several
  | "busy"         // exit 1 — e.g. agent already running
  | "unavailable"  // exit 2 — socket missing/refused, port busy, omp binary missing
  | "protocol"     // exit 2 — version mismatch, malformed reply
  | "timeout"      // exit 3
```

**Policies per format.**

| | human (default) | `--json` | `--ndjson` |
|---|---|---|---|
| channel | stdout; errors and hints → stderr | envelope → stdout only | envelope lines → stdout only |
| ANSI | theme colors; `--no-color` / `NO_COLOR` strips | never | never |
| prompts | TTY confirm (`kill`), pickers, inline inputs | never prompt | never prompt |
| streaming | `log -f`, live board/watch | one snapshot; `-f` rejected | one line per event; `log -f` streams forever |
| alt-screen | board, watch, full log, picker | never | never |

- **Decision:** error envelopes go to stdout, not stderr. **Why:** machines parse one channel; the exit code carries failure status, and stderr stays reserved for human-attached diagnostics in human mode. **Contract:** exactly one envelope per invocation on stdout, never mixed with human text.
- **Decision:** interactive surfaces under machine modes degrade to static snapshots rather than erroring. **Why:** `hub --json` in a pipeline is precisely how scripts poll the board; failing would force a second code path onto every consumer. **Contract:** the snapshot shape is stable and versioned with status.json's `version` field; unknown fields are ignored forward.

## Exit codes

| exit | meaning | triggers |
|---|---|---|
| `0` | ok | success; clean quits (`q`); ctrl-c on followers; declined `kill` confirm |
| `1` | usage | unknown command or flag, missing args, bad `[json]` parse, `--json` + `--ndjson`, unknown or ambiguous `<id>`/`<item>`, picker without TTY, `--tail 0`, `web --json`, reply error envelopes `not_found` / `ambiguous` / `busy` |
| `2` | unavailable-hub | hub.sock missing or refused, handshake/version mismatch, `OMP_BIN` binary missing, web port busy, `ping` with no hub (the probe exit) |
| `3` | timeout | reply wait exceeded `replyTimeoutMs`; `tool` exceeded its `wait_seconds` budget |

- **Decision:** unhandled exceptions exit 1 with the message on stderr (human) or a `"usage"` envelope (machine); 2 is reserved for "the hub is not reachable". **Why:** unavailable-hub is a distinct operational state — scripts retry on 2 and fix their invocation on 1; collapsing them hides which one happened. **Contract:** every error path in ## Subcommands maps to exactly one row above; the ErrorCode → exit mapping in the envelope type is exhaustive.
- **Signals:** SIGINT / SIGTERM always restore the terminal first. Followers (`log -f`, `web`, board, watch) exit 0 — stopping a viewer is not an error. One-shot commands also exit 0 with no envelope: a successful machine invocation is defined by exactly one snapshot envelope on stdout, so an absent envelope is the interruption signal for consumers. The enumerated codes remain exactly 0/1/2/3.

## Sketches

Hue bars `▎` are two cells wide, colored per session (plain here). The cursor is `█`.

**1 — board with two attention items** (`hub`):

```text
 hub · 5 sessions · 1 agent · tilt needs approval before canary 2/3
 ⚠ NEEDS YOU ──────────────────────────────────────────────
 ▎ approval  tilt    approve deploy canary 2/3? (yes/no)
 ▎ › █                                        ⏎ answer · esc cancel
 ▎ question docs    pin @yurifrl/hub to 1.4 or latest?
 ⏳ RUNNING ───────────────────────────────────────────────
 ▎ ● tilt      working   editing deploy/canary.sh (2m)
 ▎ ● docs      waiting   asked a question (1m)
 ▎ ● web-1     working   refactoring routes (14m)
 💤 IDLE ─────────────────────────────────────────────────
 ▎ ○ api       idle 12m    assign: _
 keys ↑↓ move · type to answer · d dismiss · a assign · o open · l log · q quit
```

**2 — board, calm variant** (`hub`):

```text
 hub · 5 sessions · 1 agent · all clear — nothing needs you
 ⚠ NEEDS YOU   (empty)
 ⏳ RUNNING ───────────────────────────────────────────────
 ▎ ● tilt      working   watching canary metrics (3m)
 ▎ ● web-1     working   green tests (11m)
 💤 IDLE       (empty)
 keys l log · q quit
```

**3 — watch chat** (`hub watch`):

```text
 hub watch · 200 sessions · 1 need you
 sessions               │ systems · idle · 01a14c9d
▸○ systems              │  ▶ bash helm unittest k8s/charts/ax 2>&1 | grep -… ×2
 ○ hub                  │21:35:15 ◆ systems
 ○ DotFiles             │  Ground truth established: upstream publishes no
 ⚠ DotFiles           +3│  images for either image — the manifest pinned
 ■ 󰕮 ADMIN: Plan batte… │  …
 □ make a new release   │ ⚠ approve deploy canary 2/3?
 › ⏎ to write a message
 ↑↓ select · 1-9 jump · ⏎ write · f filter:all · < rail · > rail · PgUp/PgDn scroll · d dismiss · q quit
```

**4 — send picker** (`hub send`, no id given, query `dep` typed):

```text
 hub send — pick a session ▏dep
 ▎ ▸ tilt     deploy canary 2/3              working
 ▎   web-1    deploy routes refactor         working
 ▎   api      deploy api rewrite             idle
 ↑↓ move · ⏎ select · esc cancel · type to filter
```

After selection the message input opens on the chosen row (`› █`); ⏎ delivers.
