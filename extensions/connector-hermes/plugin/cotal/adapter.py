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
import base64
import logging
import os
import sys
import uuid
from typing import Any, Optional

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
    cache_image_from_bytes,
)
from gateway.config import Platform, PlatformConfig
from gateway.session import build_session_key

from . import approvals, clarify, hooks, journal, replies, streams
from .bridge_client import get_client
from .commands import operator_commands
from .resume import seed_chat
from .framing import format_injection, shown_sender

logger = logging.getLogger(__name__)
# How many delivered messages a turn reply can still name as the one it answers.
MAX_ANSWERING = 1024


class InjectionRefused(Exception):
    """The host would not run an answer in the session that asked. The answer is not acked, and the
    sidecar offers it again later (``deferred``)."""


# The chats the delivery daemon's notices run in, one per notice kind. They have no mesh target, so a
# turn's reply to a notice is not sent: a notice wants no answer, and its sender is the daemon, not a
# peer.
NOTICE_KINDS = ("anycast", "mention")
# The chat a turn in the user's own words runs in. It has no mesh target either, so its reply shows on
# the event plane and is not sent.
OPERATOR_CHAT = journal.OPERATOR
# The message id of each ``/stop`` an interrupt sends. The gateway answers a ``/stop`` in its chat, and
# that answer is not sent: the owner stopped the turn, not the peer the chat is with.
STOP_ID_PREFIX = "cotal-stop:"
# The file extension the gateway's image cache gets for each image type a turn may carry.
IMAGE_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}


def chat_type_for(chat_id: str) -> Optional[str]:
    """The chat type of a chat_id minted on inbound, or None for an id this adapter did not mint."""
    if chat_id.startswith("channel:"):
        return "group"
    if chat_id.startswith("dm:") or chat_id == OPERATOR_CHAT or chat_id in tuple(f"notice:{k}" for k in NOTICE_KINDS):
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
    # Set by the gateway once it created the adapter: on every adapter from Hermes 0.19, and on a
    # plugin adapter that declares it on 0.18. ``usage`` reads the operator chat's agent through it.
    gateway_runner = None

    def __init__(self, config: PlatformConfig) -> None:
        super().__init__(config, Platform("cotal"))
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._client = get_client()
        # message id -> the contextId of a message delivered into its sender's own chat, for the
        # turn reply that names it (the gateway's ``reply_to``).
        self._answering: dict[str, Optional[str]] = {}
        # id(event) -> (source, the event journal's key) for each Cotal message the gateway is
        # processing, and each turn it took and has not finished. The gateway holds the event until
        # its processing completes, so the id is not reused. The sidecar starts the owner's next
        # turn only while this is empty (``busy``).
        self._busy: dict[int, tuple[Any, Optional[str]]] = {}

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
        # A bridge socket in a directory that exists and is not private to this user is never dialed,
        # and no retry repairs that. Report it as a permanent fatal instead of calling the platform
        # connected with a reader that will never connect.
        refused = self._client.refusal()
        if refused:
            self._set_fatal_error("cotal_bridge_not_private", refused, retryable=False)
            await self._notify_fatal_error()
            return False
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
        self._client.start(
            self._on_incoming, self._on_bridge_refused, self._on_turn, self._on_request, approvals.answered,
            lambda frame: clarify.answered(self._client, frame),
        )  # reader thread

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

    def _on_bridge_refused(self, reason: str) -> None:
        """The reader found the bridge socket's directory not private after connect (reader thread):
        report the same permanent fatal on the gateway's loop, since the bridge will not dial again."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return

        def report() -> None:
            self._set_fatal_error("cotal_bridge_not_private", reason, retryable=False)
            self._mark_disconnected()
            asyncio.ensure_future(self._notify_fatal_error())

        loop.call_soon_threadsafe(report)

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
        refused = self._client.refusal()
        if refused:
            raise RuntimeError(refused)  # never report a reply delivered over a bridge that will not dial
        if reply_to is not None and str(reply_to).startswith(STOP_ID_PREFIX):
            return SendResult(success=True, message_id=uuid.uuid4().hex)
        if chat_id == OPERATOR_CHAT and journal.operator_reply(content):
            await asyncio.to_thread(hooks.journal_wake)
        answered = str(reply_to) if reply_to is not None else None
        if answered not in self._answering:
            answered = None
        # Trimmed as Hermes trims a reply it does not stream: a streamed one keeps the blank lines the
        # model wrote around it.
        self._client.reply(
            _target_for(chat_id), content.strip(), answered, self._answering.get(answered) if answered else None
        )
        return SendResult(success=True, message_id=uuid.uuid4().hex)

    def supports_draft_streaming(self, chat_type: Any = None, metadata: Any = None, **_: Any) -> bool:
        """Hermes streams a reply here as drafts when its streaming is on (streams.py). Hermes 0.21
        also passes the chat id."""
        return True

    def streaming_overflow_limit(self) -> Optional[int]:
        """No limit: a streamed reply is sent whole, as an unstreamed one is, never split into
        several messages."""
        return sys.maxsize

    async def send_draft(self, chat_id: str, draft_id: int, content: str, metadata: Any = None) -> SendResult:
        """The reply so far: the event plane streams the text it adds. Nothing goes to the mesh, which
        gets the reply when the gateway sends it."""
        if journal.armed():
            streams.draft(self._client, chat_id, draft_id, content)
        return SendResult(success=True)

    @classmethod
    def supports_exec_approval_buttons(cls) -> bool:
        """Hermes 0.21 calls ``send_exec_approval`` only for an adapter that says it renders approvals;
        0.18 and 0.19 call it whenever the class defines it."""
        return approvals.asks()

    async def send_exec_approval(
        self, chat_id: str, command: str, session_key: str, description: Optional[str] = None, metadata: Any = None, **flags: Any
    ) -> SendResult:
        """A command waits for approval: behind the agent's prompt desk for a seat launched with
        ``askPermissions`` (approvals.py). Any other seat leaves it to the gateway's text prompt."""
        if not approvals.asks():
            return SendResult(success=False, error="this seat does not ask the agent's owner")
        sent = approvals.request(self._client, command, session_key, description or "", flags)
        return SendResult(success=True, message_id=uuid.uuid4().hex) if sent else SendResult(success=False, error="the sidecar is not connected")

    async def send_clarify(
        self, chat_id: str, question: str, choices: Optional[list], clarify_id: str, session_key: str, metadata: Any = None
    ) -> SendResult:
        """The model asks a clarify question: on the agent's prompt desk in the operator chat
        (clarify.py), and as Hermes's own text prompt in any other chat."""
        if chat_id != OPERATOR_CHAT:
            return await super().send_clarify(chat_id, question, choices, clarify_id, session_key, metadata)
        if clarify.ask(self._client, chat_id, question, choices, clarify_id, session_key):
            return SendResult(success=True, message_id=uuid.uuid4().hex)
        return SendResult(success=False, error="the sidecar is not connected")

    async def on_processing_start(self, event: MessageEvent) -> None:
        """The gateway began processing a message: a turn starts (journal.py)."""
        if getattr(event.source, "chat_id", None) == OPERATOR_CHAT:
            journal.operator_turn_started()
        key = uuid.uuid4().hex
        logged = journal.processing_started(key)
        self._set_busy(event, key if logged else None)
        if logged:
            await asyncio.to_thread(hooks.journal_wake)

    async def on_processing_complete(self, event: MessageEvent, outcome: Any) -> None:
        """The gateway finished a message, however it ended, its reply delivered or not. The journal
        is written before the busy count, which can end the turn's presence (src/hermes-hooks.ts)."""
        entry = self._busy.pop(id(event), None)
        key = entry[1] if entry else None
        ended = str(getattr(outcome, "value", outcome))
        chat_id = str(getattr(event.source, "chat_id", ""))
        streams.turn_done(self._client, chat_id)
        clarify.turn_done(self._client, chat_id)
        wake = getattr(event.source, "chat_id", None) == OPERATOR_CHAT and journal.operator_done(ended)
        if key and journal.processing_done(key, ended):
            wake = True
        if wake:
            await asyncio.to_thread(hooks.journal_wake)
        self._client.busy(len(self._busy))

    def _set_busy(self, event: MessageEvent, key: Optional[str]) -> None:
        self._busy[id(event)] = (event.source, key)
        self._client.busy(len(self._busy))

    def _session_key(self, source: Any) -> str:
        """The key the adapter holds a session under, built as ``handle_message`` builds it."""
        return build_session_key(
            source,
            group_sessions_per_user=self.config.extra.get("group_sessions_per_user", True),
            thread_sessions_per_user=self.config.extra.get("thread_sessions_per_user", False),
        )

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

    def _on_turn(self, frame: dict) -> None:
        """A turn in the user's own words, off-loop like _on_incoming. It runs in the operator chat,
        whose reply has no mesh target and is not sent."""
        loop = self._loop
        turn_id = str(frame.get("id") or "")
        if loop is None:
            self._client.turn_taken(turn_id, "the gateway is not running")
            return
        images = frame.get("images") if isinstance(frame.get("images"), list) else []
        fut = asyncio.run_coroutine_threadsafe(self._inject_turn(str(frame.get("text") or ""), images), loop)
        fut.add_done_callback(lambda f: self._turn_done(turn_id, f))

    def _turn_done(self, turn_id: str, fut: Any) -> None:
        error = "cancelled" if fut.cancelled() else fut.exception()
        self._client.turn_taken(turn_id, None if error is None else str(error))

    def _operator_source(self) -> Any:
        return self.build_source(
            chat_id=OPERATOR_CHAT, chat_name=OPERATOR_CHAT, chat_type="dm", user_id=OPERATOR_CHAT, user_name=OPERATOR_CHAT
        )

    async def _inject_turn(self, text: str, images: list) -> None:
        # The base adapter drops a message it has no handler for yet, and a dropped turn would hold
        # the seat busy for good.
        if not self._message_handler:
            raise RuntimeError("the gateway has not finished starting")
        # The gateway's own image cache checks each image's size and bytes, and refuses before the
        # turn starts.
        paths = [cache_image_from_bytes(base64.b64decode(i["data"], validate=True), IMAGE_EXTENSIONS[i["mimeType"]]) for i in images]
        source = self._operator_source()
        fork = os.environ.get("COTAL_HERMES_FORK_SESSION")
        if fork:
            seed_chat(getattr(self, "_session_store", None), source, fork)
        event = MessageEvent(
            text=text,
            message_type=MessageType.PHOTO if paths else MessageType.TEXT,
            source=source,
            media_urls=paths,
            media_types=[i["mimeType"] for i in images],
        )
        # Busy from here, so the sidecar holds the next turn until this one is done.
        self._set_busy(event, None)
        try:
            await self.handle_message(event)
        except BaseException:
            self._busy.pop(id(event), None)
            self._client.busy(len(self._busy))
            raise

    def _on_request(self, frame: dict) -> None:
        """A request from the sidecar (reader thread): ``interrupt``, ``usage`` or ``commands``,
        answered once it ran on the gateway loop."""
        request_id = str(frame.get("id") or "")
        work = {"interrupt": self._interrupt, "usage": self._usage, "commands": self._commands}.get(str(frame.get("t")))
        loop = self._loop
        if work is None or loop is None:
            self._client.answer(request_id, error="the gateway is not running" if work else f"unknown request {frame.get('t')!r}")
            return
        fut = asyncio.run_coroutine_threadsafe(work(), loop)
        fut.add_done_callback(lambda f: self._client.answer(request_id, *_outcome(f)))

    async def _interrupt(self) -> dict:
        """Stop every session that has a Cotal message in progress with the gateway's own ``/stop``,
        which interrupts its agent and cancels its processing. The journal then ends the run as
        cancelled."""
        sessions: dict[str, Any] = {}
        for source, _ in list(self._busy.values()):
            sessions.setdefault(self._session_key(source), source)
        for source in sessions.values():
            stop = MessageEvent(text="/stop", message_type=MessageType.TEXT, source=source, message_id=f"{STOP_ID_PREFIX}{uuid.uuid4().hex}")
            await self.handle_message(stop)
        return {"state": "interrupted" if sessions else "idle"}

    async def _usage(self) -> dict:
        """The operator chat's context window and cost, as the agent holding that session reports
        them, read the way the gateway's own ``/usage`` reads them. A field it has not reported is
        left out."""
        runner = self.gateway_runner
        if runner is None:
            raise RuntimeError("the gateway gave the cotal adapter no runner, so usage cannot be read")
        key = runner._session_key_for_source(self._operator_source())
        agent = runner._running_agents.get(key)
        if not hasattr(agent, "context_compressor"):
            with runner._agent_cache_lock:
                cached = runner._agent_cache.get(key)
            agent = cached[0] if cached else None
        usage: dict = {}
        ctx = getattr(agent, "context_compressor", None)
        used = int(getattr(ctx, "last_prompt_tokens", 0) or 0)
        size = int(getattr(ctx, "context_length", 0) or 0)
        if used > 0 and size > 0:
            usage["context"] = {"used": used, "size": size}
        if agent is not None and getattr(agent, "session_cost_status", "unknown") != "unknown":
            usage["cost"] = {"amount": float(agent.session_estimated_cost_usd), "currency": "USD"}
        return usage

    async def _commands(self) -> dict:
        """The slash commands the operator chat may run (commands.py)."""
        runner = self.gateway_runner
        if runner is None:
            raise RuntimeError("the gateway gave the cotal adapter no runner, so its commands cannot be read")
        return {"commands": await asyncio.to_thread(operator_commands, runner.config, self._operator_source())}

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
        sender = shown_sender(msg)

        if kind == "channel":
            ch = msg.get("channel") or "general"
            chat_id, chat_name = f"channel:{ch}", f"#{ch}"
        elif msg.get("notice") in NOTICE_KINDS:
            chat_id, chat_name = f"notice:{msg['notice']}", f"{msg['notice']} notices"
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
            source_fields = asker
        else:
            if msg.get("id"):
                self._answering[msg["id"]] = msg.get("contextId")
                if len(self._answering) > MAX_ANSWERING:
                    del self._answering[next(iter(self._answering))]
            source_fields = dict(
                chat_id=chat_id,
                chat_name=chat_name,
                chat_type=chat_type,
                user_id=msg.get("fromId"),
                user_name=sender,
            )
        # Hermes keys groups on the alternate participant ID first. Use the channel for that
        # part of the key, including answers routed back here, and keep the real sender for auth.
        if source_fields["chat_type"] == "group":
            source_fields["user_id_alt"] = source_fields["chat_id"]
        source = self.build_source(**source_fields)
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
        # `cotal spawn --resume`: a chat whose session is still empty starts as a branch of the
        # launcher's fork, so its first turn carries the source context. No await sits between the
        # check and the switch inside seed_chat, so a second message for the same chat sees it done.
        fork = os.environ.get("COTAL_HERMES_FORK_SESSION")
        if fork:
            seed_chat(getattr(self, "_session_store", None), source, fork)
        await self.handle_message(event)


def _outcome(fut: Any) -> tuple[Optional[dict], Optional[str]]:
    """A finished request's answer: its data, or why it failed."""
    if fut.cancelled():
        return None, "cancelled"
    exc = fut.exception()
    return (None, str(exc) or type(exc).__name__) if exc else (fut.result(), None)
