"""Hermes lifecycle hooks → Cotal presence (the relay.ts pattern, in Python).

Each hook makes a one-shot connection to connector-core's control socket
(``COTAL_CONTROL_SOCKET``) and runs the control exchange (``control_exchange.py``): the hook and
the sidecar each prove they hold the launch's control key without sending it, then the hook sends
``{"event": {"hook_event_name": ...}}`` and reads the MAC'd reply, which the TS ``hermesHookHandle``
produced while turning the event into a presence change. The socket PATH comes from the launch env;
the KEY and its version come from the launch-material file that env points at
(``COTAL_LAUNCH_MATERIAL``), so that no descendant of the gateway inherits a control-plane secret.
Standalone mode mints and exports ``COTAL_CONTROL_KEY`` and ``COTAL_CONTROL_VERSION`` itself, so
that path is read first and is not deprecated. Before each dial the hook checks that the socket's
directory is private to this user; a directory that is not counts as no endpoint.

Hooks must never block the gateway, so the connection has a short timeout and every socket error is
swallowed. A key that cannot be resolved, a directory that is not private, or a server that does not
prove itself is NOT swallowed the same way: each means presence relays silently do nothing, which
looks exactly like a healthy seat that never does anything, so it warns once on stderr (the
launcher's log) and then stays quiet.

Hermes hook callback signatures vary by version; these take ``*args, **kwargs`` and best-effort
extract what they need, so a signature change degrades to "no detail" rather than an exception.
"""
from __future__ import annotations

import os
import socket
import sys
from typing import Any

from .control_exchange import ClientExchange, ControlConfigError, ExchangeRefused, control_key, socket_dir_problem

_TIMEOUT_S = 2.0
_warned = False


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
    try:
        key = control_key()
    except ControlConfigError as exc:
        _warn_once(f"{exc} - presence relays are disabled for this session")
        return
    if not key:
        # This is the failure that has no other symptom: the seat joins, the sidecar and the bridge
        # work, and presence never moves off its first value. Say so once rather than never.
        _warn_once(
            "control socket is configured but no control key could be resolved "
            "(neither COTAL_CONTROL_KEY nor COTAL_LAUNCH_MATERIAL carries one) - "
            "presence relays are disabled for this session"
        )
        return
    problem = socket_dir_problem(path)
    if problem:
        absent, reason = problem
        if not absent:
            _warn_once(f"{reason}, so the hook connected to nothing - presence relays are disabled for this session")
        return
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.settimeout(_TIMEOUT_S)
            s.connect(path)
            exchange = ClientExchange(s, key)
            exchange.open({"event": {"hook_event_name": event_name, **fields}})
            try:
                exchange.reply(_TIMEOUT_S)  # verified and discarded: the event is what mattered
            except (OSError, ExchangeRefused):
                pass
        finally:
            s.close()
    except ExchangeRefused:
        _warn_once("the control socket did not prove it holds this session's key, so nothing was relayed")
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
