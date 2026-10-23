# Hermes hub plugin for Hermes Agent 0.19.x
# Registered by discovery under ~/.hermes/plugins/hermes-hub/
#
# Layered like lib/ (docs/01 §Core abstractions). Hermes' container is
# Python-only and cannot import @yurifrl/hub, so this file mirrors the hub
# architecture instead of importing it; each layer maps 1:1 to its TS
# counterpart and tests/bridge_plugin_contract.test.ts pins the shared
# vocabulary so the two sides cannot drift silently:
#   DOMAIN  ↔ lib/domain/command.ts          ops vocabulary, Result, error values
#   PORT    ↔ docs/02 §hub.sock              the cmd/reply wire contract
#   ADAPTER ↔ lib/adapters/unix_socket.ts    (client half) transport + deadline
#   SURFACE ↔ cli/src/commands/*.ts          the hermes tool + per-turn hook
# Composition mirrors cli/src/context.ts ctx.call: one op = one fresh connect.
import json
import os
import socket
import threading

# env override + default, same principle as lib/config (lib/config.ts §sock)
SOCKET_PATH = os.environ.get("OMP_HUB_SOCK") or os.environ.get("HUB_SOCKET") or "/run/hub.sock"
FRAME_DEADLINE_S = 30          # docs/02 §hub.sock per-op deadline
HEARTBEAT_LINES = 3            # digest session rows


# ── DOMAIN ───────────────────────────────────────────────────────────────────
# Mirror of lib/domain/command.ts: pure vocabulary and error values. No I/O.

# == OP_NAMES — the parity test enforces exact equality
OPS = (
    "list", "attention", "answer", "assign", "send", "tool",
    "spawn", "kill", "archive", "logTail", "summaries",
    "agent", "sessions", "ping",
)

# v1 tool surface: board work only. `tool` (agent→agent forwarding) and the
# chunky read ops `logTail`/`summaries` stay hub-side for now. Widen by
# adding ops here and to the description below — the parity test guards it.
ADVERTISED_OPS = (
    "list", "attention", "answer", "assign", "send", "spawn",
    "kill", "archive", "agent", "sessions", "ping",
)

# Closed error taxonomy — the only codes a local error may carry (wire errors
# from the hub pass through verbatim; they already carry this shape).
TRANSIENT_CODES = ("unavailable-hub", "timeout")


def ok(value) -> dict:
    """Errors are values, not exceptions (docs/01 §Error model).
    Result shape mirrors lib CommandReply: {ok, value} | {ok, error}."""
    return {"ok": True, "value": value}


def fail(code: str, message: str, *, retryable: bool = None, cause=None) -> dict:
    """Mirrors lib hubError(): retryable defaults true only for the transient
    codes; `cause` is structured detail, never a raised exception."""
    return {"ok": False, "error": {
        "code": code,
        "message": message,
        "retryable": (code in TRANSIENT_CODES) if retryable is None else retryable,
        **({"cause": cause} if cause is not None else {}),
    }}


# ── PORT ─────────────────────────────────────────────────────────────────────
# docs/02 §hub.sock: newline-delimited JSON frames, one object per \n.

def cmd_frame(op: str, args: dict) -> dict:
    """`agent` caller: hermes works an omp agent's board, not cli/web."""
    return {
        "v": 1, "ch": "cmd", "cmdId": f"hermes-{os.getpid()}-{op}",
        "op": op, "args": args, "by": "agent",
    }


# The one-shot cmd client never sends hello (docs/02 §hub.sock: hello is
# optional). The push client below is the subscriber that does.


# ── ADAPTER ──────────────────────────────────────────────────────────────────
# Client half of lib/adapters/unix_socket.ts: one-shot connect → cmd → reply
# → close, deadline-bounded, errors as values.

def _recv_frame(sock: socket.socket) -> bytes:
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("hub closed the socket mid-frame")
        buf += chunk
    return buf


def call_hub(op: str, args: dict) -> dict:
    """Same shape as cli/src/context.ts ctx.call, minus the persistent hello:
    a fresh connection per call. Nothing throws past this boundary."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(FRAME_DEADLINE_S)
            s.connect(SOCKET_PATH)
            s.sendall(json.dumps(cmd_frame(op, args)).encode() + b"\n")
            reply = json.loads(_recv_frame(s).decode())
    except socket.timeout as e:
        return fail("timeout", "hub reply exceeded the per-op deadline", cause=str(e))
    except OSError as e:
        # TS client: only a refused connection is retryable; a missing socket
        # or a mid-frame close is not.
        return fail("unavailable-hub", f"cannot reach hub at {SOCKET_PATH}: {e}",
                    retryable=isinstance(e, ConnectionRefusedError))
    if reply.get("ch") == "error":     # protocol-level frame: {v, ch:"error", error}
        err = reply.get("error") or {}
        return fail(err.get("code", "bad-frame"), err.get("message", ""))
    if reply.get("ok") is False:       # op rejected as a value (CommandReply)
        return {"ok": False, "error": reply.get("error") or
                {"code": "bad-frame", "message": "", "retryable": False}}
    return ok(reply.get("result", reply))


# ── PUSH ─────────────────────────────────────────────────────────────────────
# Hub → Hermes push (docs/07 §Push): the reverse of the SURFACE section. The
# hub's bus fans committed state out as `event` frames on hub.sock
# (lib/adapters/event_frames.ts); the one-shot cmd client above cannot receive
# them, so this half is a long-lived subscriber: hello(subscribe) → frames →
# deliver. Delivery goes THROUGH Hermes, not around it: every notification
# fires the `pi_hub_session_stopped` hook so sibling plugins can subscribe
# (the event-emitter contract), then lands on WhatsApp via the live gateway's
# own adapter. All Hermes imports are lazy + guarded: outside the gateway
# container the subscriber still runs, hooks degrade to no-ops, sends no-op.

# Attention kinds that need a human: hub AttentionKind (lib/domain/session.ts)
# minus "idle" (bookkeeping, not a request). Pin in the parity test.
NOTIFY_KINDS = ("approval", "question", "blocked")

# Platforms we will actually deliver to (gateway/config.py Platform values).
ROUTES = ("whatsapp", "whatsapp_cloud")

# Newline text separators in the attention message.
SEP = "\n"

_lock = threading.Lock()
# Dedup ledger: session id → last notified marker. An attention id while that
# attention cycle is open (a new raise gets a new id, so it re-notifies);
# "ended" after the finish notice (subsequent agent_end frames dedup to
# no-ops); absent = never notified, so plain finishes are not news. In-memory
# by design — a plugin restart at worst re-notifies once.
_notified: dict = {}
_route = {"platform": None, "chat_id": None}


def pre_gateway_dispatch(event, gateway=None, session_store=None, **_kw):
    """Route capture: remember the last real WhatsApp conversation so pushes
    know where to land (docs/07 §Push). Args-only dict return → allow."""
    src = getattr(event, "source", None)
    platform = getattr(src, "platform", None)
    val = getattr(platform, "value", None)
    if val in ROUTES and getattr(src, "chat_id", None):
        with _lock:
            _route["platform"] = val
            _route["chat_id"] = src.chat_id
    return {"action": "allow"}


def _route_target() -> tuple:
    with _lock:
        return _route["platform"], _route["chat_id"]


def _hermes(name):
    """Import one Hermes symbol, or None outside the gateway container."""
    mods = {
        "invoke_hook": ("hermes_cli.plugins", "invoke_hook"),
        "runner_ref": ("gateway.run", "_gateway_runner_ref"),
        "platform": ("gateway.config", "Platform"),
        "run_async": ("model_tools", "_run_async"),
    }
    try:
        mod = __import__(mods[name][0], fromlist=[mods[name][1]])
        return getattr(mod, mods[name][1])
    except Exception:  # ImportError/AttributeError — degraded mode is fine
        return None


def _fire_session_stopped(event: dict) -> None:
    """Emit the event for sibling plugins (never raises)."""
    fn = _hermes("invoke_hook")
    if fn is None:
        return
    try:
        fn("pi_hub_session_stopped", event=event)
    except Exception:
        pass


def _whatsapp_deliver(platform: str, chat_id: str, text: str) -> None:
    """Send via the live gateway's own adapter (docs/07 §Push). Best effort:
    any failure is swallowed — the hook already carried the event to Hermes."""
    runner = None
    fn = _hermes("runner_ref")
    if fn is not None:
        try:
            runner = fn()          # weakref: one call yields the runner
        except Exception:
            runner = None
    adapter = None
    if runner is not None:
        adapters = getattr(runner, "adapters", None) or {}
        # Keys are gateway/config.py Platform enums (gateway/run.py:3087),
        # so match on the enum member whose .value equals the route string.
        P = _hermes("platform")
        key = P(platform) if P is not None else None
        adapter = adapters.get(key)
    if adapter is None:
        return
    run_async = _hermes("run_async")
    if run_async is None:
        return
    try:
        run_async(adapter.send(chat_id, text))
    except Exception:
        pass


def _notify(session_id: str, marker: str, text: str) -> None:
    """Dedup + fire + deliver as one decide-and-commit step under the lock
    (docs/07 §Push). Never raises."""
    with _lock:
        if _notified.get(session_id) == marker:
            return
        _notified[session_id] = marker
        platform, chat_id = _route["platform"], _route["chat_id"]
    event = {
        "v": 1, "kind": "pi_hub_session_stopped", "sessionId": session_id,
        "marker": marker, "message": text,
    }
    _fire_session_stopped(event)
    if platform and chat_id:
        _whatsapp_deliver(platform, chat_id, text)


def _handle_frame(m: dict) -> None:
    """React to one subscribed event frame (docs/07 §Push). Never raises."""
    try:
        if m.get("ch") != "event" or m.get("kind") not in ("attention", "agent_end"):
            return
        if m.get("kind") == "attention":
            item = m.get("item") or {}
            if item.get("resolvedAt"):        # resolve = removal, not a stop
                return
            if item.get("kind") not in NOTIFY_KINDS:
                return
            _notify(
                item.get("sessionId") or "?", item.get("id") or "?",
                SEP.join([
                    "🛑 omp session needs you",
                    f"session: {item.get('sessionId', '?')} ({item.get('kind', '?')})",
                    str(item.get("text", "")),
                ]),
            )
            return
        sid = m.get("sessionId") or "?"
        with _lock:
            if _notified.get(sid) is not None:
                return            # open attention owns this session, or the
                                  # finish notice already went out
        _notify(sid, "ended", f"✅ omp session finished: {sid}")
    except Exception:
        pass


def _subscribe_forever() -> None:
    """Connect → hello(subscribe) → newline frames until the hub dies; then
    reconnect with 5s backoff (lib/adapters/unix_socket.ts client half,
    long-lived). Frames that fail to parse are skipped, not fatal."""
    while True:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(60)
                s.connect(SOCKET_PATH)
                hello = {"v": 1, "ch": "hello", "client": "plugin",
                         "subscribe": True}
                s.sendall(json.dumps(hello).encode() + b"\n")
                json.loads(_recv_frame(s).decode())  # hello ack — required
                while True:
                    m = json.loads(_recv_frame(s).decode())
                    _handle_frame(m)
        except Exception:
            pass
        threading.Event().wait(5)


_PUSH_THREAD = None


def ensure_push_thread() -> None:
    """Start the push subscriber exactly once (SURFACE register calls this;
    a no-op everywhere else)."""
    global _PUSH_THREAD
    if _PUSH_THREAD is None:
        _PUSH_THREAD = threading.Thread(
            target=_subscribe_forever, name="hermes-hub-push", daemon=True)
        _PUSH_THREAD.start()


# ── SURFACE ──────────────────────────────────────────────────────────────────


def hub_tool(args, **_kw) -> str:
    """The `hub` tool the agent calls: every advertised op as op=<name>.
    Hermes 0.19 invokes handlers as handler(args, **kwargs) — the args dict
    positionally plus bookkeeping kwargs (task_id, parent_agent, …)."""
    if not isinstance(args, dict):
        args = {}
    op = args.get("op")
    if op == "stream":  # not a tool call — pushing is out of scope (docs/07 §Limits)
        return json.dumps(fail("unknown-op", "stream is not a tool op"), ensure_ascii=False)
    if op not in OPS:   # surface-level rejection, like commander does for the CLI
        return json.dumps(fail("unknown-op", f"no such hub op: {op!r}", cause=list(OPS)),
                          ensure_ascii=False)
    rest = {k: v for k, v in args.items() if k != "op"}
    return json.dumps(call_hub(op, rest), ensure_ascii=False)


def pre_llm_call(**payload) -> dict:
    """Each turn: pull the board snapshot and inject a compact digest as context.
    Same injection path as memory prefetch; pull-per-turn, no push channel.
    Hermes invokes hooks as cb(**payload); only `{"context": ...}` injects.
    Shapes per docs/02-data-contracts.md: list → {hub, sessions: MAP<id, record>,
    attention, archived}; each record carries phase/description/title."""
    board = call_hub("list", {})
    lines = []
    if board.get("ok") and isinstance(board["value"], dict):
        data = board["value"]
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
    return {"context": f"<hub-status>\nomp hub board — live omp sessions + open attention items:\n{digest}\n</hub-status>"}


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
                    "op": {"type": "string", "enum": list(ADVERTISED_OPS)},
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
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
    ensure_push_thread()
