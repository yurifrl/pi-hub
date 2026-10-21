# Hermes hub plugin for Hermes Agent 0.19.x
# Registered by discovery under ~/.hermes/plugins/hermes-hub/
# Ops: hub tool (one-shot cmd/reply per call), pre_llm_call context digest per turn.
import json
import os
import socket
import threading

SOCKET_PATH = os.environ.get("HUB_SOCKET", "/run/hub.sock")
FRAME_DEADLINE_S = 30          # docs/02 §hub.sock per-op deadline
HEARTBEAT_LINES = 3            # docs/02: status, logTail, summaries are the cheap ones
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
            cmd = {"v": 1, "ch": "cmd", "op": op, "id": f"hermes-{os.getpid()}-{op}", "by": "agent", **args}
            s.sendall(json.dumps(cmd).encode() + b"\n")
            reply = json.loads(_recv_frame(s))
    except (ConnectionError, socket.timeout, FileNotFoundError, OSError) as e:
        return {"ok": False, "error": {"code": "unavailable-hub", "retryable": True, "detail": str(e)}}
    if reply.get("ch") == "error":
        return {"ok": False, "error": reply.get("error", {"code": "bad-frame"})}
    return {"ok": True, "data": reply.get("data", reply)}


def hub_tool(ctx, op: str, **kwargs) -> str:
    """The `hub` tool the agent calls: every hub op as op=<name>."""
    if op == "stream":  # not a tool call — pushing is out of scope for v1
        return json.dumps({"ok": False, "error": {"code": "unknown-op", "detail": "stream is not a tool op"}})
    return json.dumps(_call_hub(op, kwargs), ensure_ascii=False)


def pre_llm_call(ctx, payload) -> dict:
    """Each turn: pull list + attention and inject a compact digest as context.
    Same injection path as memory prefetch; pull-per-turn, no push channel."""
    board = _call_hub("list", {})
    attn = _call_hub("attention", {})
    lines = []
    if attn.get("ok") and attn["data"]:
        for item in attn["data"]:
            lines.append(f"ATTENTION {item.get('id','?')} [{item.get('status','?')}]: {item.get('title','')}")
    if board.get("ok") and board["data"]:
        sessions = board["data"] if isinstance(board["data"], list) else board["data"].get("sessions", [])
        for s in sessions[:HEARTBEAT_LINES]:
            lines.append(f"SESSION {s.get('id','?')} [{s.get('state','?')}] {s.get('summary','')[:120]}")
    digest = "\n".join(lines) if lines else "hub: nothing needs attention right now."
    return {"context": f"<hub-status>\n{digest}\n</hub-status>"}


def register(ctx):
    ctx.register_tool(
        name="hub",
        toolset="pi-hub",
        schema={
            "type": "object",
            "properties": {
                "op": {"type": "string", "enum": ["list", "attention", "answer", "assign", "send", "tool", "spawn", "kill", "archive", "logTail", "summaries", "agent", "sessions"]},
            },
            "required": ["op"],
        },
        handler=hub_tool,
    )
    ctx.register_hook("pre_llm_call", pre_llm_call)