"""Hermes's command approvals behind the agent's prompt desk, for a seat launched with
``askPermissions``. The sidecar holds the prompts (src/approvals.ts).

When a command or ``execute_code`` meets Hermes's approval rules in a gateway session, the gateway
calls the adapter's ``send_exec_approval`` and the agent thread waits for
``resolve_gateway_approval`` or the approval timeout. Here the request goes to the sidecar as an
``approval`` frame, and the owner's answer comes back as an ``approval_answer`` frame, which
resolves it. ``post_approval_response`` reports how the wait ended, so the sidecar can settle the
prompt. The gateway resolves the oldest waiting approval of a session, and the sidecar answers a
session's prompts in the order they opened.

``send_exec_approval``, ``resolve_gateway_approval``, the approval timeout and both hooks are
Hermes's own across the supported 0.18 to 0.21 range. ``reason`` reached
``resolve_gateway_approval`` in 0.19, so a deny note is sent only where Hermes takes it.
"""
from __future__ import annotations

import inspect
import threading
import uuid
from typing import Any, Optional

from .control_exchange import asks_permissions

# What each frame carries for the option the owner may pick, in Hermes's own choice names.
ONCE, SESSION, ALWAYS, DENY = "once", "session", "always", "deny"

_lock = threading.Lock()
# approval id -> the gateway session it waits in.
_open: dict[str, str] = {}
# session -> the tool each approval Hermes asked for in it is about, oldest first
# (``pre_approval_request`` runs on the thread that runs the tool, before ``send_exec_approval``).
_tools: dict[str, list[tuple[str, str]]] = {}
_tool = threading.local()
_asks: Optional[bool] = None


def asks() -> bool:
    """Whether this launch puts approvals behind the prompt desk. Read once: the material does not
    change during a launch."""
    global _asks
    if _asks is None:
        _asks = asks_permissions()
    return _asks


def tool_started(name: str, call_id: str) -> None:
    """``pre_tool_call``: the tool this thread runs, which an approval it asks for is about."""
    _tool.name, _tool.call_id = name, call_id


def approval_requested(session_key: str) -> None:
    """``pre_approval_request``: note the tool the approval is about for ``send_exec_approval``."""
    if not asks():
        return
    with _lock:
        _tools.setdefault(session_key, []).append((getattr(_tool, "name", "") or "terminal", getattr(_tool, "call_id", "")))


def _timeout_s() -> int:
    try:
        from tools.approval_context import _get_approval_timeout  # 0.21
    except ImportError:
        from tools.approval import _get_approval_timeout
    return int(_get_approval_timeout())


def _takes_reason() -> bool:
    from tools.approval import resolve_gateway_approval

    return "reason" in inspect.signature(resolve_gateway_approval).parameters


def _resolve(session_key: str, choice: str, reason: Optional[str]) -> int:
    from tools.approval import resolve_gateway_approval

    if reason and _takes_reason():
        return resolve_gateway_approval(session_key, choice, reason=reason)
    return resolve_gateway_approval(session_key, choice)


def request(client: Any, command: str, session_key: str, description: str, flags: dict) -> bool:
    """Send one approval to the sidecar. ``flags`` are the gateway's ``allow_permanent``,
    ``allow_session`` and ``smart_denied``. When the frame cannot be written, the approval is denied
    at once with the cause: the prompt desk is the only path, and a text prompt in the chat would
    let whoever the chat is with answer it."""
    with _lock:
        waiting = _tools.get(session_key) or []
        tool, call_id = waiting.pop(0) if waiting else ("terminal", "")
    smart_denied = bool(flags.get("smart_denied"))
    choices = [ONCE]
    if flags.get("allow_session", True) and not smart_denied:
        choices.append(SESSION)
    if flags.get("allow_permanent", True) and not smart_denied:
        choices.append(ALWAYS)
    choices.append(DENY)
    approval_id = uuid.uuid4().hex
    frame = {
        "t": "approval", "id": approval_id, "session": session_key, "command": command,
        "description": description, "tool": tool, "choices": choices, "note": _takes_reason(),
        "timeoutMs": _timeout_s() * 1000,
    }
    if call_id:
        frame["toolCallId"] = call_id
    # Open before the frame goes: the sidecar answers at once when it cannot hold a prompt.
    with _lock:
        _open[approval_id] = session_key
    if client.approval(frame):
        return True
    with _lock:
        _open.pop(approval_id, None)
    _resolve(session_key, DENY, "Cotal could not ask the agent's owner: the sidecar is not connected.")
    return False


def answered(frame: dict) -> None:
    """The owner's answer (``approval_answer``), on the bridge's reader thread. The approval stays
    open until Hermes's wait for it ends (``ended``)."""
    with _lock:
        session_key = _open.get(str(frame.get("id") or ""))
    choice = str(frame.get("choice") or "")
    if session_key is None or choice not in (ONCE, SESSION, ALWAYS, DENY):
        return
    _resolve(session_key, choice, frame.get("reason") if isinstance(frame.get("reason"), str) else None)


def ended(client: Any, session_key: str, outcome: str) -> None:
    """``post_approval_response``: the session's oldest approval stopped waiting, answered, denied,
    stopped or timed out. Reported only for an approval the sidecar holds, so its queue and
    Hermes's stay aligned."""
    with _lock:
        oldest = next((k for k, s in _open.items() if s == session_key), None)
        if oldest is None:
            return
        del _open[oldest]
    client.approval_end(session_key, outcome)
