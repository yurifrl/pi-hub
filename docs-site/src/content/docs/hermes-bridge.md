---
title: Hermes bridge
description: Bridge Nous Research's Hermes agent (containerized) to hub.sock — hub ops from inside the container, hub events pushed into the agent's context.
---

# Hermes bridge

Status: **design verified at the transport level; implementation lands in `bridge/`** (this repo) + one line in `lib/adapters/unix_socket.ts`.

## What it does

Runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) in a container on this host and connects it to pi-hub:

- **hub → Hermes** — the hub's live event stream is pulled each turn by a plugin `pre_llm_call` hook and injected into the agent's context.
- **Hermes → hub** — a plugin-registered `hub` tool speaks `hub.sock` cmd/reply frames, so the agent can run ops: `list`, `attention`, `answer`, `assign`, `send`, `tool`, `spawn`, `kill`, `archive`, `logTail`, `summaries`, `agent`.

## Transport — why a single-file socket mount

Measured on this host (Apple container, virtiofs), October 2026:

| transport | result |
|---|---|
| directory mount containing `hub.sock` | dead — `ENOTSUP` on the socket inode |
| TCP to the hub web port (`127.0.0.1:4820`) | dead — loopback-only listener, unreachable from the container |
| **bind-mount of the socket file itself** (`-v ~/.hub/hub.sock:/run/hub.sock:ro` style single-file) | **works** — `connect()` traverses virtiofs end-to-end |

Two measured properties of the single-file mount that the design leans on:

- **Permissions are enforced**: a `0755` socket yields `EACCES` for the container's root; `0777` connects. The hub must chmod the socket after listen.
- **No stale-inode pin**: with a client retrying every 2s inside the container, the hub was killed and rebound the same path (new inode) — the container transparently connected to the new socket (one transient failure during the kill window, then success). So hub restarts are survivable with plain retry-on-error.

## Auth posture

`hub.sock` has no connection auth today — the `forbidden` error code exists in the taxonomy (`lib/domain/command.ts`) but nothing emits it. Any local process can connect, which is the host status quo. A `0777` socket does not weaken this; the container is just another local client. Frames carry `by` (caller tag: `cli`, `web`, `plugin`, `agent`) for attribution only.

## Repo layout

```
bridge/
  hermes-hub-plugin/     # the Hermes plugin (mounted into the container)
    plugin.yaml
    __init__.py
  Dockerfile             # FROM python:3.13-slim-trixie + hermes-agent wheel (Renovate-bumped pin)
  compose.yaml           # mounts: plugin dir → ~/.hermes/plugins/hermes-hub, hub.sock → /run/hub.sock
```

## Plugin shape (verified against the 0.19.0 wheel)

Discovery scans directories containing `plugin.yaml` + `__init__.py` under `~/.hermes/plugins/` (or `HERMES_BUNDLED_PLUGINS`). Entry point is `register(ctx)`:

- `ctx.register_tool(name, toolset, schema, handler, ...)` — the `hub` tool; handler opens a one-shot cmd/reply connection to `/run/hub.sock` per call (no long-lived socket; restart-proof by construction).
- `ctx.register_hook("pre_llm_call", cb)` — each turn, run `list` + `attention` against the socket and return `{"context": <digest>}`; Hermes injects the returned context into the turn (same injection path as memory prefetch). This is pull-per-turn; the plugin API has no inbound-push channel.
- Per-op deadline is 30s (docs/02 §hub.sock); the client maps `unavailable-hub` to a retryable error and never throws across the port boundary.

## Hub-side change (one line)

`lib/adapters/unix_socket.ts` `start()` listens and returns; add `chmod(path, 0o777)` after listen so the container's root can connect. `forbidden` stays unenforced (see Auth posture).

## Run

Prerequisite: the hub is running (in omp: `/hub-start` — it serves `hub.sock` at `~/.hub/hub.sock`). Then, from the repo root:

```sh
container compose -f bridge/compose.yaml up --build
```

What the compose file provides:

- `hub.sock` — single-file mount (see Transport; must exist before `up` or the mount fails — i.e. `/hub-start` first).
- `bridge/hermes-hub-plugin/` — bind-mounted read-only at `~/.hermes/plugins/hermes-hub` (plugin discovery path inside the container).
- Agent identity/config — mounted like the existing home-systems hermes services (see `/Users/yuri/Workdir/yuri/home-systems` compose pattern).

## Verification plan (end-to-end)

1. Host-side, hub up: `hub` CLI `list` op through `hub.sock` (existing behavior).
2. In-container: `hermes plugins doctor` shows `hermes-hub` loaded.
3. In-container: the `hub` tool's `list` op returns the live session board.
4. End-to-end: prompt Hermes "what needs me right now?" — answer reflects `attention`; follow with "answer <id> …" — `status.json` attention item resolves; next turn's context injection reflects the change.

## Known gaps / follow-ups

- Image build needs disk headroom (base image not cached locally).
- Wheel pin is `hermes-agent==0.19.0` (exists on PyPI under `requires-python >=3.11,<3.14` — hence the 3.13-slim base; the image is auto-bumped by Renovate, mirroring `k8s/images/hermes/Dockerfile` in home-systems).
- Push delivery (hub → Hermes without waiting for a turn) is out of scope for v1; the plugin API offers no inbound socket. Revisit if Hermes adds a listener API.
