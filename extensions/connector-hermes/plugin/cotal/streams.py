"""Reply text Hermes streams to the adapter, as deltas for the event plane (src/events.ts).

Hermes gives a gateway adapter a reply while the model writes it only through its own streaming:
with ``streaming.enabled`` and the draft transport, its stream consumer calls ``send_draft`` with
the text so far, under one draft id for each stretch of text between tool calls. Each stretch is a
stream under a key minted here. The sidecar journals the new text of each draft under the key, and
the ``assistant`` record of the model response that carries the text names the key
(``journal.model_response``), which closes the stream. A draft of a closed stream is dropped.

Drafts arrive on the gateway's event loop and the record is written on the agent's thread, so the
key is closed under the lock before the record is appended: no delta of a stream is sent after the
record that closes it.
"""
from __future__ import annotations

import threading
import uuid
from typing import Any, Optional

_lock = threading.Lock()
# chat id -> the stream open there: its draft id, key, the text streamed so far, and whether a draft
# stopped extending that text, after which the saved record carries the rest.
_open: dict[str, dict] = {}
# chat id -> the draft id of the last stream closed there. Hermes counts draft ids up across the
# process, so a draft at or below it belongs to a closed stream.
_closed: dict[str, int] = {}


def draft(client: Any, chat_id: str, draft_id: int, content: str) -> None:
    """One draft of the reply in ``chat_id``: send the text it adds to the stream's last one."""
    with _lock:
        if draft_id <= _closed.get(chat_id, 0):
            return
        stream = _open.get(chat_id)
        ended = stream["key"] if stream is not None and stream["draft"] != draft_id else None
        if stream is None or ended is not None:
            stream = {"draft": draft_id, "key": "hermes-stream-" + uuid.uuid4().hex, "text": "", "broken": False}
            _open[chat_id] = stream
        # A saved response can lack the blank lines its drafts begin or end with. So the stream
        # leaves out leading whitespace and holds trailing whitespace until text follows it: what
        # streamed is then the start of the saved text, which closes the stream.
        shown = content.strip()
        delta = ""
        if not stream["broken"]:
            if shown.startswith(stream["text"]):
                delta = shown[len(stream["text"]):]
                stream["text"] = shown
            else:
                stream["broken"] = True
        key = stream["key"]
    # A stretch that ended with no response saved for it, as a failed request leaves.
    if ended is not None:
        client.delta_end(ended)
    if delta:
        client.delta(key, delta)


def saved(chat_id: Optional[str]) -> Optional[str]:
    """Close the stream open in ``chat_id`` for the model response about to be recorded, and return
    its key."""
    if not chat_id:
        return None
    with _lock:
        stream = _open.pop(chat_id, None)
        if stream is None:
            return None
        _closed[chat_id] = stream["draft"]
        return stream["key"]


def turn_done(client: Any, chat_id: str) -> None:
    """The gateway finished a message in ``chat_id``: end a stream no saved response closed, as an
    interrupted reply leaves."""
    with _lock:
        stream = _open.pop(chat_id, None)
        if stream is not None:
            _closed[chat_id] = stream["draft"]
    if stream is not None:
        client.delta_end(stream["key"])


def response_saved(platform: str) -> Optional[str]:
    """Close the stream of the model response about to be recorded on ``platform``, in the chat of
    the turn this thread runs, and return its key."""
    with _lock:
        if platform != "cotal" or not _open:
            return None
    # Hermes's session context names the chat. It is read only once a reply streamed, so a Hermes
    # without it fails there and nowhere else.
    from gateway.session_context import get_session_env

    return saved(get_session_env("HERMES_SESSION_CHAT_ID", ""))
