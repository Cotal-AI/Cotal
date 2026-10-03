"""cotal_* tools — the deliberate, proactive mesh actions, exposed to the Hermes agent.

A turn's *reply* is delivered automatically (the adapter routes it back to whoever messaged), so
these tools are for reaching OTHER peers/channels, seeing who's around, reporting status, and
growing the team. We do NOT hand-write the list: the TS sidecar renders it once from the shared
``cotalToolSpecs`` and writes the descriptors to ``COTAL_TOOLS_FILE``; this reads that file and
registers each as a Hermes plugin tool whose handler forwards the call (by name) over the bridge
and returns the sidecar's already-formatted text result.

The exact ``ctx.register_tool`` schema/handler contract is the Hermes plugin API across the
supported 0.18 to 0.21 range, where its signature is unchanged; adjust the ``_spec`` shape if a
future supported version differs.
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable, Optional

from . import replies
from .bridge_client import get_client

# The tools that publish a message. A call from a cotal session stamps that session's context id,
# so a peer's answer can be routed back to the session that asked (see replies.py).
_SENDS = frozenset({"cotal_dm", "cotal_send", "cotal_anycast"})


def _spec(descriptor: dict) -> dict:
    """A Hermes tool spec from a sidecar descriptor ({name, description, parameters})."""
    params = descriptor.get("parameters") or {"type": "object", "properties": {}, "required": []}
    return {
        "name": descriptor["name"],
        "description": descriptor.get("description", ""),
        "parameters": params,
    }


def _handler(name: str) -> Callable[..., str]:
    """Forward a tool call to the sidecar; the sidecar runs the shared spec and returns the text.

    Hermes' tool registry invokes handlers as ``handler(args, **kwargs)``, passing call context
    (``task_id`` and friends). We act only on ``args`` and accept-and-ignore the rest, so the
    signature can't reject a kwarg the host adds."""
    def run(args: dict, **_ctx: Any) -> str:
        try:
            session = _calling_session() if name in _SENDS else None
            context_id = replies.issue(session) if session else None
            return get_client().call_tool(name, args or {}, context_id=context_id)
        except Exception as e:  # surfaced back to the model as the tool result
            return f"cotal error: {e}"

    return run


def _calling_session() -> Optional[dict]:
    """The gateway source of the cotal session this tool call runs in, or None for a session on
    another platform. The gateway binds it per task (``gateway.session_context``, Hermes 0.16+)."""
    from gateway.session_context import get_session_env

    if get_session_env("HERMES_SESSION_PLATFORM", "") != "cotal":
        return None
    chat_id = get_session_env("HERMES_SESSION_CHAT_ID", "")
    if not chat_id:
        return None
    return {
        "chat_id": chat_id,
        "chat_type": get_session_env("HERMES_SESSION_CHAT_TYPE", ""),
        "chat_name": get_session_env("HERMES_SESSION_CHAT_NAME", ""),
        "user_id": get_session_env("HERMES_SESSION_USER_ID", ""),
        "user_name": get_session_env("HERMES_SESSION_USER_NAME", ""),
    }


def _load_descriptors() -> list[dict]:
    path = os.environ.get("COTAL_TOOLS_FILE")
    if not path:
        raise RuntimeError("COTAL_TOOLS_FILE not set — the sidecar must publish the tool descriptors")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise RuntimeError(f"COTAL_TOOLS_FILE {path} did not contain a tool list")
    return data


def register_tools(ctx: Any) -> None:
    for descriptor in _load_descriptors():
        name = descriptor["name"]
        ctx.register_tool(
            name=name,
            toolset="cotal",
            schema=_spec(descriptor),
            handler=_handler(name),
        )
