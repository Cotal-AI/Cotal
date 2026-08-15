"""cotal_* tools — the deliberate, proactive mesh actions, exposed to the Hermes agent.

A turn's *reply* is delivered automatically (the adapter routes it back to whoever messaged), so
these tools are for reaching OTHER peers/channels, seeing who's around, reporting status, and
growing the team. We do NOT hand-write the list: the TS sidecar renders it once from the shared
``cotalToolSpecs`` and writes the descriptors to ``COTAL_TOOLS_FILE``; this reads that file and
registers each as a Hermes plugin tool whose handler forwards the call (by name) over the bridge
and returns the sidecar's already-formatted text result.

The exact ``ctx.register_tool`` schema/handler contract is the Hermes 0.16 plugin API; adjust the
``_spec`` shape if a pinned version differs.
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable

from .bridge_client import get_client


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
        # DELIBERATELY NOT CAUGHT. This used to return `f"cotal error: {e}"`, which turned every
        # failure — including a refusal the shared spec had flagged — into an ordinary successful
        # return whose only trace was English in the text. The host decides how to present a raised
        # exception; it cannot decide anything about a failure it was never told about.
        return get_client().call_tool(name, args or {})

    return run


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
