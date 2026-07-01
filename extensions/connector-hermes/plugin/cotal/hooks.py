"""Hermes lifecycle hooks → Cotal presence (the relay.ts pattern, in Python).

Each hook makes a one-shot connection to connector-core's control socket
(``COTAL_CONTROL_SOCKET``), sends ``{"token": ..., "event": {"hook_event_name": ...}}``, and
ignores the reply — the TS ``hermesHookHandle`` turns it into a presence change. The control server
validates ``token`` (constant-time) before doing anything, so a frame without it is dropped. Both
the path and token come from the launch env (shared with the sidecar). Hooks must never block the
gateway, so the connection has a short timeout and every error is swallowed.

Hermes hook callback signatures vary by version; these take ``*args, **kwargs`` and best-effort
extract what they need, so a signature change degrades to "no detail" rather than an exception.
"""
from __future__ import annotations

import json
import os
import socket
from typing import Any

_TIMEOUT_S = 2.0


def relay(event_name: str, **fields: Any) -> None:
    """Forward one lifecycle event to the connector's control socket; fire-and-forget."""
    path = os.environ.get("COTAL_CONTROL_SOCKET")
    token = os.environ.get("COTAL_CONTROL_TOKEN")
    if not path or not token:
        return
    payload = {"token": token, "event": {"hook_event_name": event_name, **fields}}
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(_TIMEOUT_S)
        s.connect(path)
        s.sendall((json.dumps(payload) + "\n").encode())
        try:
            s.recv(65536)  # read + discard the reply
        except OSError:
            pass
        s.close()
    except OSError:
        pass


def _extract_tool(args: tuple, kwargs: dict) -> tuple[str, Any]:
    """Best-effort tool name + input from whatever Hermes passes the pre_tool_call hook."""
    ctx: dict = {}
    for a in args:
        if isinstance(a, dict):
            ctx = a
            break
    ctx = {**ctx, **kwargs}
    name = ctx.get("tool_name") or ctx.get("name") or ctx.get("tool") or ""
    inp = ctx.get("tool_input") or ctx.get("arguments") or ctx.get("input") or ctx.get("args")
    return str(name), inp


# ---- hook callbacks (registered in __init__.register) -----------------------

def on_session_start(*args: Any, **kwargs: Any) -> None:
    relay("on_session_start")


def pre_llm_call(*args: Any, **kwargs: Any) -> None:
    relay("pre_llm_call")


def pre_tool_call(*args: Any, **kwargs: Any) -> None:
    name, inp = _extract_tool(args, kwargs)
    relay("pre_tool_call", tool_name=name, tool_input=inp)


def post_llm_call(*args: Any, **kwargs: Any) -> None:
    relay("post_llm_call")


def on_session_end(*args: Any, **kwargs: Any) -> None:
    relay("on_session_end")
