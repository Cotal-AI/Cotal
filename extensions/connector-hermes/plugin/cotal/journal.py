"""The turn journal behind a Hermes seat's AG-UI event plane.

Hermes keeps no append-only record of a turn that an outside reader can resume at a cursor: its
session store rewrites a transcript in place when it compacts one, and writes a row again when it
fills a tool-call turn's answer late. So this plugin writes one, from the gateway's per-message
processing callbacks, the adapter's replies in the operator chat, and the ``pre_llm_call``,
``post_api_request`` and ``post_tool_call`` hooks, all present across the supported 0.18 to 0.21
range. Each record is appended on the thread that reports it, before the
gateway moves past the step it describes. The sidecar reads the file from a cursor and maps each
record to AG-UI (src/agui-map.ts).

The launcher names the file in ``COTAL_HERMES_EVENTS`` only when the seat's event plane is armed;
without it nothing is written. Only Cotal-platform work is recorded: an adopted profile also serves
the operator's other platforms, whose turns are not the mesh's to see.

A record that cannot be written raises. Hermes logs a raising hook and carries on with the turn, so
the loss is in the gateway log rather than silent.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Optional

# The user and chat id of the gateway's operator chat, where the owner's turns run (adapter.py).
OPERATOR = "operator"

_lock = threading.Lock()
# Tool calls a Cotal-platform model response announced, so a result from another platform's turn
# in the same gateway is not recorded.
_calls: set[str] = set()
# The model was called for the operator chat's message in progress, so its reply is on the journal
# already as model responses. One operator message runs at a time.
_operator_model = False


def _field(obj: Any, name: str) -> Any:
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def _text(content: Any) -> str:
    """The text of a message's content: a string, or the text parts of a part list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(_field(p, "text") or "") for p in content if _field(p, "type") == "text")
    return ""


def _path() -> Optional[str]:
    return os.environ.get("COTAL_HERMES_EVENTS") or None


def _append(kind: str, **fields: Any) -> bool:
    path = _path()
    if not path:
        return False
    record = {"k": kind, "rid": uuid.uuid4().hex, "ts": int(time.time() * 1000), **fields}
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"), default=str) + "\n"
    with _lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
    return True


def processing_started(key: str) -> bool:
    """The gateway began processing one Cotal message (``on_processing_start``)."""
    return _append("start", key=key)


def processing_done(key: str, outcome: str) -> bool:
    """The gateway finished one Cotal message: ``success``, ``failure`` or ``cancelled``."""
    return _append("done", key=key, outcome=outcome)


def model_response(platform: str, message: Any) -> bool:
    """One model response of a Cotal-platform turn (``post_api_request``'s ``assistant_message``)."""
    if not _path() or platform != "cotal" or message is None:
        return False
    calls = []
    for call in _field(message, "tool_calls") or []:
        fn = _field(call, "function")
        args = _field(fn, "arguments")
        call_id = str(_field(call, "id") or "")
        if not call_id:
            continue
        calls.append({
            "id": call_id,
            "name": str(_field(fn, "name") or ""),
            "arguments": args if isinstance(args, str) else json.dumps(args if args is not None else {}),
        })
    reasoning = _field(message, "reasoning") or _field(message, "reasoning_content")
    with _lock:
        _calls.update(c["id"] for c in calls)
    return _append(
        "assistant",
        content=_text(_field(message, "content")),
        reasoning=reasoning if isinstance(reasoning, str) else "",
        calls=calls,
    )


def tool_result(tool_call_id: str, result: Any, status: Optional[str]) -> bool:
    """A tool call's result (``post_tool_call``), for a call a Cotal-platform response announced."""
    with _lock:
        if tool_call_id not in _calls:
            return False
        _calls.discard(tool_call_id)
    text = result if isinstance(result, str) else json.dumps(result, default=str)
    return _append("tool", id=tool_call_id, result=text, error=status not in (None, "ok"))


def operator_turn_started() -> None:
    """The gateway began processing an operator-chat message."""
    global _operator_model
    with _lock:
        _operator_model = False


def model_called(platform: str, sender: str) -> None:
    """The model was called for a turn (``pre_llm_call``): the operator chat's, when its sender is
    the operator on the Cotal platform."""
    global _operator_model
    if platform == "cotal" and sender == OPERATOR:
        with _lock:
            _operator_model = True


def operator_reply(content: str) -> bool:
    """The gateway's reply in the operator chat, recorded when the model was not called for the
    message in progress: a slash command's output, or a refusal the gateway wrote itself. A reply
    the model wrote is on the journal already as its responses."""
    with _lock:
        if _operator_model:
            return False
    if not content.strip():
        return False
    return _append("reply", content=content)
