"""Hermes's clarify questions on the agent's prompt desk. The sidecar holds the prompts
(src/clarify.ts).

When the model calls Hermes's clarify tool in a gateway session, the gateway calls the adapter's
``send_clarify`` and the agent thread waits for ``resolve_gateway_clarify`` or the clarify timeout.
A question in the operator chat, where the owner's own turns run, goes to the sidecar as a
``clarify`` frame. The owner's answer comes back as a ``clarify_answer`` frame, which resolves it,
and ``clarify_end`` reports whether Hermes was still waiting. A question still open when its turn
ends is reported ended unanswered. A question in any other chat keeps Hermes's own text prompt, which
whoever that chat is with answers, as they answer the turn.

``send_clarify``, ``resolve_gateway_clarify`` and the clarify timeout are Hermes's own across the
supported 0.18 to 0.21 range. A multiple choice arrived in 0.21, answered with a JSON array of the
chosen labels.
"""
from __future__ import annotations

import threading
from typing import Any, Optional

_lock = threading.Lock()
# clarify id -> the chat it was asked in.
_open: dict[str, str] = {}


def _timeout_s() -> int:
    from tools.clarify_gateway import get_clarify_timeout

    return int(get_clarify_timeout())


def _multiple(clarify_id: str) -> bool:
    """Whether Hermes asks for any number of the choices (0.21's ``multi_select``)."""
    from tools import clarify_gateway

    with clarify_gateway._lock:
        return bool(getattr(clarify_gateway._entries.get(clarify_id), "multi_select", False))


def ask(client: Any, chat_id: str, question: str, choices: Optional[list], clarify_id: str, session_key: str) -> bool:
    """Send one question to the sidecar. False when no connection took the frame."""
    frame = {
        "t": "clarify", "id": clarify_id, "session": session_key, "question": question,
        "choices": [str(c) for c in choices or []], "multiple": bool(choices) and _multiple(clarify_id),
        "timeoutMs": _timeout_s() * 1000,
    }
    # Open before the frame goes: the sidecar answers at once when it cannot hold a prompt.
    with _lock:
        _open[clarify_id] = chat_id
    if client.clarify(frame):
        return True
    with _lock:
        _open.pop(clarify_id, None)
    return False


def answered(client: Any, frame: dict) -> None:
    """The owner's answer (``clarify_answer``), on the bridge's reader thread."""
    clarify_id = str(frame.get("id") or "")
    response = frame.get("response")
    with _lock:
        known = _open.pop(clarify_id, None) is not None
    if not known:
        return
    resolved = False
    if isinstance(response, str):
        from tools.clarify_gateway import resolve_gateway_clarify

        resolved = bool(resolve_gateway_clarify(clarify_id, response))
    client.clarify_end(clarify_id, resolved)


def turn_done(client: Any, chat_id: str) -> None:
    """The gateway finished a message in ``chat_id``: Hermes no longer waits on a question asked
    there, as one that timed out or that the owner's next message answered leaves."""
    with _lock:
        ended = [k for k, chat in _open.items() if chat == chat_id]
        for k in ended:
            del _open[k]
    for k in ended:
        client.clarify_end(k, False)
