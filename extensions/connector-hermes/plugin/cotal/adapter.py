"""Cotal gateway platform adapter.

Inbound: the sidecar pushes mesh messages over the bridge; the adapter builds a ``MessageEvent``
and calls ``handle_message`` — which wakes an idle session or **queues + interrupts a running one**
(the gateway's own busy handling), so a peer can DRIVE a live turn, not just leave a message.
Outbound: the gateway hands a turn's reply to ``send()``, which the adapter routes back to that
message's mesh origin (the channel it came in on, or a DM to the sender), as a reply to it.

A DM answering a question one of this gateway's sessions asked goes to that session, not to
``dm:<sender>`` (see replies.py).
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Optional

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform, PlatformConfig

from . import hooks, replies
from .bridge_client import get_client
from .framing import format_injection

logger = logging.getLogger(__name__)
# How many delivered messages a turn reply can still name as the one it answers.
MAX_ANSWERING = 1024


class InjectionRefused(Exception):
    """The host would not run an answer in the session that asked. The answer is not acked, and the
    sidecar offers it again later (``deferred``)."""


def chat_type_for(chat_id: str) -> Optional[str]:
    """The chat type of a chat_id minted on inbound, or None for an id this adapter did not mint."""
    if chat_id.startswith("channel:"):
        return "group"
    if chat_id.startswith("dm:"):
        return "dm"
    return None


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
        # message id -> the contextId of a message delivered into its sender's own chat, for the
        # turn reply that names it (the gateway's ``reply_to``).
        self._answering: dict[str, Optional[str]] = {}

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

        # THE BRIDGE MUST BE PROVED LIVE BEFORE THE PLATFORM IS CALLED CONNECTED.
        #
        # Marking connected is what removes this platform from anyone's attention: upstream's
        # watcher only ever revisits platforms in `_failed_platforms`, entry to which requires a
        # failed connect or a NOTIFIED retryable fatal, and there is no periodic health probe of a
        # platform believed connected. A dying reader thread notifies nothing by itself. So a
        # reader that is absent or already dead here would produce a platform reporting connected
        # and deaf for the lifetime of the process, which is precisely the failure this connector
        # exists to prevent.
        #
        # Reporting it as a RETRYABLE fatal is what turns the gateway's existing machinery into a
        # real safety net: the platform enters `_failed_platforms` and the background reconnect
        # queue picks it up, rather than the operator being the health check.
        if self._client.reader_is_dead():
            self._set_fatal_error(
                "cotal_bridge_reader_dead",
                "cotal bridge reader thread is not running, so no mesh traffic can arrive",
                retryable=True,
            )
            await self._notify_fatal_error()
            return False

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
        # The gateway delivers a turn's reply here → route it back to the message's mesh origin. A
        # reply to a message delivered here names it and copies its contextId (it belongs to the
        # asker); otherwise the sidecar pairs a DM reply with its peer's oldest unanswered message.
        answered = str(reply_to) if reply_to is not None else None
        if answered not in self._answering:
            answered = None
        self._client.reply(
            _target_for(chat_id), content, answered, self._answering.get(answered) if answered else None
        )
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
        if not recv_key or fut.cancelled():
            return
        exc = fut.exception()
        if exc is None:
            # Address the bridge by the per-delivery receive key (#624): the wire id of an id-less
            # message is "", which the truthiness check below would silently never deliver-ack, and
            # the bridge's own guard would then never clear its in-flight slot.
            self._client.delivered(recv_key)
        elif isinstance(exc, InjectionRefused):
            # Not taken: free the bridge's in-flight slot without an ack, so the answer is kept.
            self._client.deferred(recv_key)

    async def _inject(self, msg: dict) -> None:
        kind = msg.get("kind")
        sender = msg.get("fromName") or "peer"

        if kind == "channel":
            ch = msg.get("channel") or "general"
            chat_id, chat_name = f"channel:{ch}", f"#{ch}"
        else:  # dm / anycast → a turn whose reply goes straight back to the sender
            chat_id, chat_name = f"dm:{msg.get('fromId')}", sender
        chat_type = chat_type_for(chat_id)

        # The answer to a question one of our sessions asked runs in that session. The sidecar has
        # checked that its sender is the peer the question went to.
        asker = replies.asking_session(msg.get("contextId")) if msg.get("answersQuestion") is True else None
        if asker and "session_key" in asker:  # a session on another platform
            try:
                taken = replies.inject(format_injection(msg), asker["session_key"])
            except Exception:
                # A host that raised has not taken it: keep the answer for the asker, as for a refusal.
                logger.exception(
                    "cotal: the host failed to run an answer in session %s; it is kept and offered again",
                    asker["session_key"],
                )
                raise InjectionRefused(asker["session_key"]) from None
            if taken:
                return
            # Running it in another session would consume the answer where nobody asked for it.
            logger.warning(
                "cotal: the host refused to run an answer in session %s; it is kept and offered "
                "again. Allow it with plugins.entries.cotal.allow_gateway_injection: true",
                asker["session_key"],
            )
            raise InjectionRefused(asker["session_key"])
        if asker:
            source = self.build_source(**asker)
        else:
            if msg.get("id"):
                self._answering[msg["id"]] = msg.get("contextId")
                if len(self._answering) > MAX_ANSWERING:
                    del self._answering[next(iter(self._answering))]
            source = self.build_source(
                chat_id=chat_id,
                chat_name=chat_name,
                chat_type=chat_type,
                user_id=msg.get("fromId"),
                user_name=sender,
            )
        event = MessageEvent(
            # A PEER NAMES ITSELF AND WRITES ITS OWN BODY, so neither is framing. This text is
            # auto-injected into a turn rather than returned when the model asks, so the model never
            # had the chance to distrust it, and the attribution plus the body go through one
            # neutralization rather than being concatenated raw. Measured against the raw form: a
            # body carrying a newline produced a second attribution line, reading as a message from
            # a peer that never sent one, and a sender naming itself `Ada] hi [dm from Boss` closed
            # the real attribution and opened a forged one. Same rule, same character class, as
            # `framing.ts` on the TypeScript side.
            text=format_injection(msg),
            message_type=MessageType.TEXT,
            source=source,
            message_id=msg.get("id"),
        )
        await self.handle_message(event)
