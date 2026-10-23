# Hermes hub plugin for Hermes Agent 0.19.x
# Registered by discovery under ~/.hermes/plugins/hermes-hub/
# Ops: hub tool (one-shot cmd/reply per call), pre_llm_call context digest per turn.
import json
import os
import socket
import threading

SOCKET_PATH = os.environ.get("OMP_HUB_SOCK") or os.environ.get("HUB_SOCKET") or "/run/hub.sock"
FRAME_DEADLINE_S = 30          # docs/02 §hub.sock per-op deadline
HEARTBEAT_LINES = 3            # digest session rows
POLL_INTERVAL_S = 2            # retry cadence for connect(); restart-proof (new inode OK)


def _recv_frame(sock: socket.socket) -> bytes:
    # newline-delimited JSON frames, one object per \n (docs/02 §hub.sock)
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("hub closed the socket mid-frame")
        buf += chunk
    return buf


def _call_hub(op: str, args: dict) -> dict:
    """One-shot connect → cmd frame → reply frame → close.
    `unavailable-hub` maps to a retryable error; nothing throws past this."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(FRAME_DEADLINE_S)
            s.connect(SOCKET_PATH)
            cmd = {"v": 1, "ch": "cmd", "cmdId": f"hermes-{os.getpid()}-{op}", "op": op, "args": args, "by": "agent"}
            s.sendall(json.dumps(cmd).encode() + b"\n")
            reply = json.loads(_recv_frame(s))
    except (ConnectionError, socket.timeout, FileNotFoundError, OSError) as e:
        return {"ok": False, "error": {"code": "unavailable-hub", "retryable": True, "detail": str(e)}}
    if reply.get("ch") == "error":
        return {"ok": False, "error": reply.get("error", {"code": "bad-frame"})}
    if reply.get("ok") is False:
        return {"ok": False, "error": reply.get("error", {"code": "bad-frame", "detail": reply.get("message", "")})}
    return {"ok": True, "data": reply.get("result", reply)}


def hub_tool(args, **_kw) -> str:
    """The `hub` tool the agent calls: every hub op as op=<name>.
    Hermes 0.19 invokes handlers as handler(args, **kwargs) — the args dict
    positionally plus bookkeeping kwargs (task_id, parent_agent, …)."""
    if not isinstance(args, dict):
        args = {}
    op = args.pop("op", None)
    if op == "stream":  # not a tool call — pushing is out of scope for v1
        return json.dumps({"ok": False, "error": {"code": "unknown-op", "detail": "stream is not a tool op"}})
    args.pop("op", None)  # tolerate duplicate keys
    return json.dumps(_call_hub(op, args), ensure_ascii=False)


def pre_llm_call(**payload) -> dict:
    """Each turn: pull the board snapshot and inject a compact digest as context.
    Same injection path as memory prefetch; pull-per-turn, no push channel.
    Hermes invokes hooks as cb(**payload); only `{"context": ...}` injects.
    Shapes per docs/02-data-contracts.md: list → {hub, sessions: MAP<id, record>,
    attention, archived}; each record carries phase/description/title."""
    board = _call_hub("list", {})
    lines = []
    if board.get("ok") and isinstance(board["data"], dict):
        data = board["data"]
        for item in data.get("attention", []):
            if isinstance(item, dict) and not item.get("resolvedAt"):
                lines.append(
                    f"ATTENTION {item.get('id', '?')} [{item.get('kind', '?')} "
                    f"on {item.get('sessionId', '?')[:8]}]: {str(item.get('text', ''))[:120]}"
                )
        sessions = data.get("sessions", {})
        if isinstance(sessions, dict):
            rows = list(sessions.items())[:HEARTBEAT_LINES]
            lines.extend(
                f"SESSION {sid[:8]} [{rec.get('kind', '?')} {rec.get('phase', '?')}] "
                f"{str(rec.get('description') or rec.get('title') or '')[:80]}"
                + (f" @ {rec['cwd']}" if rec.get("cwd") else "")
                for sid, rec in rows
                if isinstance(rec, dict)
            )
    digest = "\n".join(lines) if lines else "hub: nothing needs attention right now."
    return {"context": f"<hub-status>\nomp hub board — live omp sessions + attention items:\n{digest}\n</hub-status>"}


def register(ctx):
    ctx.register_tool(
        name="hub",
        toolset="pi-hub",
        schema={
            "name": "hub",
            "description": (
                "Work the omp hub board (pi-hub): every live omp session on this machine plus open attention items."
                " Set op to one hub op and pass that op's args:"
                " list/sessions — roster of omp sessions;"
                " attention — {action: list|dismiss, id} for open attention items;"
                " answer — {id, text} reply to an attention item;"
                " send — {sessionId, text} message an omp session;"
                " assign — {sessionId, task} give a session a task;"
                " spawn — {name?, model?} new hub worker;"
                " kill/archive — {sessionId} (kill accepts a worker `name`);"
                " agent — promote to hub agent (needs an omp-embedded hub);"
                " ping — liveness."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["list", "attention", "answer", "assign", "send", "spawn", "kill", "archive", "agent", "sessions", "ping"]},
                    "sessionId": {"type": "string", "description": "target omp session id (send/assign/kill/archive)"},
                    "text": {"type": "string", "description": "message (send) or answer body (answer)"},
                    "task": {"type": "string", "description": "task text (assign)"},
                    "id": {"type": "string", "description": "attention item id (answer; attention dismiss)"},
                    "action": {"type": "string", "enum": ["list", "dismiss"], "description": "attention op action, default list"},
                    "name": {"type": "string", "description": "worker name (spawn; kill fallback)"},
                    "model": {"type": "string", "description": "model id (spawn)"},
                },
                "required": ["op"],
            },
        },
        handler=hub_tool,
    )
    ctx.register_hook("pre_llm_call", pre_llm_call)