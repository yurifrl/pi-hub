---
title: Hermes bridge
description: Run Hermes Agent in a container, working the hub board from inside it — start here with three commands.
---

# Hermes bridge

## Run it (start here)

Three steps, in order:

**1. Start the hub** on the host — in any omp session with the plugin loaded:

```sh
/hub-start
```

That session becomes the hub and creates `~/.hub/hub.sock` (chmod `0777` after
listen, `lib/adapters/unix_socket.ts` — the container connects as uid 1000).

**2. Bring up Hermes** from the repo root:

```sh
container compose -f bridge/compose.yaml up --build
```

First run pulls the base image — needs disk headroom. The socket file must
already exist (step 1) or the single-file mount fails at start.

**3. Work the hub from inside Hermes.** Open the Hermes session and just ask:

> Use the hub tool: list the sessions, then answer session abc123 with "on it".

Everything the watcher agent can do, Hermes can now do — same `hub.sock` ops.

## What Hermes gets

Two injection points, registered by `bridge/hermes-hub-plugin/`:

- **`hub` tool** — one-shot op per call: `list`, `attention`, `answer`,
  `assign`, `send`, `tool`, `spawn`, `kill`, `archive`, `logTail`,
  `summaries`, `agent`. Reply is the hub's JSON frame verbatim.
- **`pre_llm_call` hook** — every turn injects a `<hub-status>` digest:
  open attention items + first three sessions, so Hermes knows the board
  state without being asked.

## How the transport works

```mermaid
flowchart LR
    H["hub session<br/>(omp, /hub-start)"] ---|~/.hub/hub.sock<br/>chmod 0777| S["single-file mount<br/>→ /run/hub.sock"]
    S --- C["Hermes container<br/>uid 1000"]
    C -->|cmd frame, v:1| H
    H -->|reply frame| C
```

- **Wire protocol** — newline-delimited JSON frames, one object per `\n`,
  every frame carries `v: 1`; owned by `docs/02-data-contracts.md §hub.sock`.
  The plugin speaks it directly (`bridge/hermes-hub-plugin/__init__.py`).
- **Single-file mount, not a directory** — Apple containers reject dir mounts
  over this path with `ENOTSUP`; a single-file virtiofs mount is the transport
  that works. TCP would be loopback-only and defeats the point.
- **Restart-proof** — the plugin reconnects every 2 s; a hub restart creates a
  new socket inode and the next poll finds it. No persistent connection.

## Files

| file | owns |
|---|---|
| `bridge/compose.yaml` | the service: socket mount, plugin mount, `HUB_SOCKET` env |
| `bridge/Dockerfile` | `python:3.13-slim` + pinned `hermes-agent==0.19.0` wheel (Renovate bumps it), non-root `hermes` user |
| `bridge/hermes-hub-plugin/` | plugin: `__init__.py` (tool + hook + frame codec), `plugin.yaml` (discovery manifest) |

## Limits (v1)

- **No push** — hub → Hermes delivery without an agent turn is out of scope;
  the plugin API has no inbound socket. Hermes polls per turn. Revisit if
  Hermes adds a listener API.
- **`stream` is not a tool op** — the tool rejects it explicitly.
- Per-op deadline 30 s (`docs/02 §hub.sock`); a timeout maps to a retryable
  `unavailable-hub` error, nothing throws past the plugin boundary.
