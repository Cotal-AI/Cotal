"""Drive the REAL Cotal adapter with one item the bridge pushed, and report what the gateway gets.

Invoked by `anycast-notice-auth.smoke.ts` with the item as JSON. Only the upstream `gateway` package
is stubbed, because it is not installed in CI. The adapter and its framing module are the connector's
own code. The probe reports the injected text, the chat the turn runs in, and the mesh target a
turn's answer is sent to; the TypeScript side grades them.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import types

PLUGIN_PARENT, ITEM = sys.argv[1], sys.argv[2]

# ---- stub ONLY the upstream imports --------------------------------------------------------
_base = types.ModuleType("gateway.platforms.base")


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        self.handled = []

    def build_source(self, **kw):
        return kw

    async def handle_message(self, event):
        self.handled.append(event)


class MessageEvent:
    def __init__(self, **kw):
        self.text = kw.get("text")
        self.source = kw.get("source")


class MessageType:
    TEXT = "text"


class SendResult:
    def __init__(self, **kw):
        pass


_base.BasePlatformAdapter = BasePlatformAdapter
_base.MessageEvent = MessageEvent
_base.MessageType = MessageType
_base.SendResult = SendResult

_cfg = types.ModuleType("gateway.config")


class Platform:
    def __init__(self, name):
        self.name = name


class PlatformConfig:
    pass


_cfg.Platform = Platform
_cfg.PlatformConfig = PlatformConfig

sys.modules.update(
    {
        "gateway": types.ModuleType("gateway"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": _base,
        "gateway.config": _cfg,
    }
)

# The adapter's constructor builds the bridge client singleton, which reads this path and does not
# dial it. The probe replaces the client before any reply.
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-anycast-notice.sock")
os.environ.setdefault("COTAL_CONTROL_TOKEN", "anycast-notice-probe-token")
sys.path.insert(0, PLUGIN_PARENT)

from cotal.adapter import CotalAdapter  # noqa: E402


class Recorder:
    """Stands in for the bridge client and records each reply the adapter sends."""

    def __init__(self):
        self.replies = []

    def reply(self, target, content, answered=None, context_id=None):
        self.replies.append({"target": target, "content": content})

    def close(self):
        pass


async def main() -> None:
    msg = json.loads(ITEM)
    adapter = CotalAdapter(PlatformConfig())
    adapter._client = Recorder()
    await adapter._inject(msg)
    event = adapter.handled[-1]
    chat_id = event.source["chat_id"] if isinstance(event.source, dict) else None
    await adapter.send(chat_id, "thanks, noted", reply_to=msg.get("id"))
    print("RESULT " + json.dumps({"text": event.text, "chat_id": chat_id, "replies": adapter._client.replies}))


asyncio.run(main())
