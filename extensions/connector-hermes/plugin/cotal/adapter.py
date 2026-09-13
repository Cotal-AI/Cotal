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

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        """Connect the bridge and start receiving.

        ``is_reconnect`` is keyword-only and arrives from the gateway's reconnect watcher, which
        has passed it at every call site since hermes-agent 0.18. Upstream asks adapters holding a
        server-side queue to preserve it across a reconnect so messages sent during the outage are
        delivered rather than dropped.

        This bridge has no server-side queue of its own to preserve, so there is nothing to keep
        here. What it does have is the mesh stream behind the sidecar, and the redelivery contract
        that protects it is the ack: ``_maybe_ack`` acks a message only once the inject coroutine
        has completed, so anything in flight when the platform dropped was never acked and is
        redelivered by the stream. Preserving outage-time messages is therefore already the
        behaviour on both paths, and it is the reason this method must not silently discard
        in-flight state on the reconnect path.

        What the flag does change is the restart. ``disconnect`` calls ``BridgeClient.close``,
        which latches the stop event and leaves the reader thread terminated. A reconnect that
        merely called ``start`` again would find ``_reader`` already set, return without starting
        anything, and produce a platform that reports connected while receiving nothing at all,
        which is the quiet failure mode this connector exists to avoid. On a reconnect the client
        is therefore reopened explicitly before the reader is started.
        """
        self._loop = asyncio.get_running_loop()
        if is_reconnect:
            # Clear the latched stop and drop the dead reader, so start() below really starts one.
            #
            # OFF-LOOP, and that is not incidental. `reopen` joins the closed reader with a bounded
            # wait so a thread still unwinding is not mistaken for a live one, and a reader wedged
            # in a blocking recv makes that wait run to its full timeout. Calling it inline here
            # would stall the gateway's event loop for that whole period, freezing every other
            # platform in the process to repair this one. Measured at 2.00s against a wedged
            # reader, which is exactly the kind of pause an operator would report as the gateway
            # hanging on reconnect. `to_thread` keeps the loop free while the join runs.
            await asyncio.to_thread(self._client.reopen)
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
