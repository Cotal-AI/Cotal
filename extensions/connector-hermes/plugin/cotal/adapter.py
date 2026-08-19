"""Cotal gateway platform adapter.

Inbound: the sidecar pushes mesh messages over the bridge; the adapter builds a ``MessageEvent``
and calls ``handle_message`` — which wakes an idle session or **queues + interrupts a running one**
(the gateway's own busy handling), so a peer can DRIVE a live turn, not just leave a message.
Outbound: the gateway hands a turn's reply to ``send()``, which the adapter routes back to that
message's mesh origin (the channel it came in on, or a DM to the sender).
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Optional

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform, PlatformConfig

from . import hooks
from .bridge_client import get_client


def _target_for(chat_id: str) -> dict:
    """Reverse the chat_id minted on inbound back into a mesh reply target."""
    if chat_id.startswith("channel:"):
        return {"channel": chat_id[len("channel:"):]}
    if chat_id.startswith("dm:"):
        return {"peerId": chat_id[len("dm:"):]}
    return {}


class CotalAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig) -> None:
        super().__init__(config, Platform("cotal"))
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._client = get_client()

    async def connect(self) -> bool:
        self._loop = asyncio.get_running_loop()
        self._client.start(self._on_incoming)  # reader thread → _on_incoming
        self._mark_connected()
        hooks.relay("gateway_startup")  # present + free
        return True

    async def disconnect(self) -> None:
        hooks.relay("gateway_shutdown")
        self._client.close()
        self._mark_disconnected()

    async def send(
        self, chat_id: str, content: str, reply_to: Any = None, metadata: Any = None
    ) -> SendResult:
        # The gateway delivers a turn's reply here → route it back to the message's mesh origin.
        self._client.reply(_target_for(chat_id), content)
        return SendResult(success=True, message_id=uuid.uuid4().hex)

    async def get_chat_info(self, chat_id: str) -> dict:
        if chat_id.startswith("channel:"):
            return {"name": "#" + chat_id[len("channel:"):], "type": "group"}
        return {"name": chat_id, "type": "dm"}

    # ---- inbound (bridge reader thread → gateway loop) -----------------------

    def _on_incoming(self, msg: dict) -> None:
        """Called off-loop by the bridge reader; hop onto the gateway loop to inject the turn."""
        loop = self._loop
        if loop is None:
            return
        fut = asyncio.run_coroutine_threadsafe(self._inject(msg), loop)
        fut.add_done_callback(lambda f: self._maybe_ack(msg, f))

    def _maybe_ack(self, msg: dict, fut: Any) -> None:
        """Ack a message on the mesh stream once it has been surfaced into a turn.

        VALIDATION GATE (open confirmation #4): ``handle_message`` returning means the event was
        *queued*, not necessarily *consumed into a turn*. On the pinned Hermes line, confirm the
        completion point and, if needed, move this ack to a real processing-complete hook/wrapper —
        do NOT relax it to ack-on-queue (a mesh message that never reaches the model must redeliver
        after a crash). Until proven, this acks on the inject coroutine completing without error.
        """
        recv_key = msg.get("recvKey")
        if recv_key and not fut.cancelled() and fut.exception() is None:
            # Address the bridge by the per-delivery receive key (#624): the wire id of an id-less
            # message is "", which the truthiness check below would silently never deliver-ack, and
            # the bridge's own guard would then never clear its in-flight slot.
            self._client.delivered(recv_key)

    async def _inject(self, msg: dict) -> None:
        kind = msg.get("kind")
        sender = msg.get("fromName") or "peer"
        role = msg.get("fromRole")
        tag = f"[{kind} from {sender}{f' / {role}' if role else ''}] "

        if kind == "channel":
            ch = msg.get("channel") or "general"
            chat_id, chat_type, chat_name = f"channel:{ch}", "group", f"#{ch}"
        else:  # dm / anycast → a turn whose reply goes straight back to the sender
            chat_id, chat_type, chat_name = f"dm:{msg.get('fromId')}", "dm", sender

        source = self.build_source(
            chat_id=chat_id,
            chat_name=chat_name,
            chat_type=chat_type,
            user_id=msg.get("fromId"),
            user_name=sender,
        )
        event = MessageEvent(
            text=tag + (msg.get("text") or ""),
            message_type=MessageType.TEXT,
            source=source,
            message_id=msg.get("id"),
        )
        await self.handle_message(event)
