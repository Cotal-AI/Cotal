"""Hermes lifecycle hooks → Cotal presence (the relay.ts pattern, in Python).

Each hook makes a one-shot connection to connector-core's control socket
(``COTAL_CONTROL_SOCKET``), sends ``{"token": ..., "event": {"hook_event_name": ...}}``, and
ignores the reply — the TS ``hermesHookHandle`` turns it into a presence change. The control server
validates ``token`` (constant-time) before doing anything, so a frame without it is dropped. The
socket PATH comes from the launch env; the TOKEN comes from the launch-material file that env points
at (``COTAL_LAUNCH_MATERIAL``), which is where a managed launch now carries it so that every
descendant of the gateway stops inheriting a control-plane bearer. Standalone mode still mints and
exports ``COTAL_CONTROL_TOKEN`` itself, so that path is read as a fallback and is not deprecated.

Hooks must never block the gateway, so the connection has a short timeout and every socket error is
swallowed. A token that cannot be resolved is NOT swallowed the same way: it means presence relays
silently do nothing for the life of the session, which looks exactly like a healthy seat that never
does anything, so it warns once on stderr (the launcher's log) and then stays quiet.

Hermes hook callback signatures vary by version; these take ``*args, **kwargs`` and best-effort
extract what they need, so a signature change degrades to "no detail" rather than an exception.
"""
from __future__ import annotations

import json
import os
import socket
import sys
from typing import Any

_TIMEOUT_S = 2.0
_warned = False


def _material_token() -> str | None:
    """The control token out of this launch's material file, or ``None``.

    Refuses a file other local users can read, for the same reason the TypeScript reader does: a
    material file readable beyond its owner is the disclosure the file carrier exists to prevent.
    Every failure here returns ``None`` and lets the caller warn, because a hook is not allowed to
    raise into the gateway.
    """
    path = os.environ.get("COTAL_LAUNCH_MATERIAL")
    if not path:
        return None
    try:
        if os.name != "nt" and (os.stat(path).st_mode & 0o077):
            return None
        with open(path, encoding="utf-8") as fh:
            material = json.load(fh)
    except (OSError, ValueError):
        return None
    token = material.get("controlToken") if isinstance(material, dict) else None
    return token if isinstance(token, str) and token else None


def _warn_once(message: str) -> None:
    global _warned
    if _warned:
        return
    _warned = True
    print(f"[cotal-hermes] {message}", file=sys.stderr, flush=True)


def relay(event_name: str, **fields: Any) -> None:
    """Forward one lifecycle event to the connector's control socket; fire-and-forget."""
    path = os.environ.get("COTAL_CONTROL_SOCKET")
    if not path:
        return  # not a Cotal-managed gateway at all; nothing to relay to
    # Managed launches carry the token in the launch material; standalone mode exports it directly.
    token = os.environ.get("COTAL_CONTROL_TOKEN") or _material_token()
    if not token:
        # This is the failure that has no other symptom: the seat joins, the sidecar and the bridge
        # work, and presence never moves off its first value. Say so once rather than never.
        _warn_once(
            "control socket is configured but no control token could be resolved "
            "(neither COTAL_CONTROL_TOKEN nor a readable COTAL_LAUNCH_MATERIAL with one) - "
            "presence relays are disabled for this session"
        )
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
