---
name: hub-ops
description: >-
  Operating the hub from inside any session with the hub_* tools: list,
  send, call_tool, spawn, kill, archive, attention, answer, assign.
  Covers when to raise vs answer, and summary style. Trigger when a hub_*
  tool is available or the user mentions the hub.
---

# hub-ops

How to operate the hub correctly from inside any session — worker,
subagent, or human-driven. Read state, act precisely, never fabricate.

## The nine tools, one rule each

- **`hub_list_sessions`** — read state, never guess. Always check what the
  hub reports before acting on session state.
- **`hub_send_message`** — deliver a prompt to a session. Use
  `wait_seconds` when you need a round-trip reply.
- **`hub_call_tool`** — run a tool in another session. Never fabricate a
  result; the real result comes back from the call or not at all.
- **`hub_spawn_worker`** — start a new worker session. Spawn for new work,
  not for convenience.
- **`hub_kill_worker`** — end a worker session. Kill is confirm-grade:
  confirm before killing, it is irreversible.
- **`hub_archive`** — proper close of a session. This is the only path to
  the archive; there is no other way in.
- **`hub_attention`** — list open attention items. Check before assuming
  something needs action.
- **`hub_answer`** — answer and resolve someone else's attention item.
  The answer closes the item.
- **`hub_assign`** — hand an idle session work. Assign only idle sessions.

## Raise vs answer

- Never raise attention items for your own session. Your reporter events
  plus the watcher do that.
- Answer with `hub_answer` only when you hold the context to act on the
  item. Otherwise leave it for the user.

## Summary style

When contributing a summary: ≤2 sentences, action-oriented ("deploy canary
2/3; waiting on approval"), never a narration of tool output.

## Availability rule

If a `hub_*` tool is not available, say so and stop. Never shell the `hub`
CLI as a substitute. Never fabricate a tool call that does not exist.
