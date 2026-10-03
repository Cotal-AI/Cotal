"""Which gateway session asked, so a peer's answer goes back to that session.

One gateway runs many sessions over one seat, and a peer answers a question with a DM. Keyed by its
sender, that answer would land in the session ``dm:<peer id>``, which never asked. So each session's
questions carry a context id minted here, and an inbound DM carrying one is routed to the session
that asked (SPEC §5: ``contextId`` belongs to the asker, and a reply copies it).

A context id is an unauthenticated string any peer can set, so only an id minted here, and not yet
expired, routes anything.
"""
from __future__ import annotations

import secrets
import threading
import time
from typing import Optional

# How long a session's context id keeps routing answers after its last question.
TTL_SECONDS = 24 * 3600

_lock = threading.Lock()
_by_chat: dict[str, str] = {}
_issued: dict[str, tuple[dict, float]] = {}


def issue(source: dict) -> str:
    """The context id for the session with this gateway ``source`` (its chat_id, chat_type, chat_name,
    user_id and user_name), minted on first use and refreshed on every question."""
    now = time.monotonic()
    with _lock:
        for token, (old, expires) in list(_issued.items()):
            if expires <= now:
                del _issued[token]
                _by_chat.pop(old["chat_id"], None)
        token = _by_chat.get(source["chat_id"]) or "hermes-" + secrets.token_hex(16)
        _by_chat[source["chat_id"]] = token
        _issued[token] = (dict(source), now + TTL_SECONDS)
        return token


def asking_session(context_id: object) -> Optional[dict]:
    """The gateway source of the session that issued ``context_id``, or None if none here did."""
    if not isinstance(context_id, str):
        return None
    with _lock:
        hit = _issued.get(context_id)
    if hit is None or hit[1] <= time.monotonic():
        return None
    return dict(hit[0])
