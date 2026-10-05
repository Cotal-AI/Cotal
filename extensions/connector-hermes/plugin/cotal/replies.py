"""Which gateway session asked, so a peer's answer goes back to that session.

One gateway runs many sessions over one seat, and a peer answers a question with a DM. Keyed by its
sender, that answer would land in the session ``dm:<peer id>``, which never asked. So each question
carries a context id minted here for it, and a DM answering it is routed to the session that asked
(SPEC §5: ``contextId`` belongs to the asker, and a reply copies it).

A context id is an unauthenticated string any peer can set. So an id routes a DM only when this
plugin minted it, it has not expired, and the sidecar vouches that the DM's authenticated sender is
the peer the question went to (the frame's ``answersQuestion``).

A session on the cotal platform is named by its gateway source. A session on another platform, such
as a Telegram topic, is named by its session key: the answer is injected into it through the host
(``ctx.inject_message``), which the operator allows with
``plugins.entries.cotal.allow_gateway_injection: true``.
"""
from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Callable, Optional

# How long a question's context id keeps routing answers after it was asked.
TTL_SECONDS = 24 * 3600
# How many unexpired questions are remembered; the oldest goes first.
MAX_QUESTIONS = 4096

_lock = threading.Lock()
_issued: dict[str, tuple[dict, float]] = {}
_inject: Optional[Callable[..., Any]] = None


def bind_host(inject_message: Callable[..., Any]) -> None:
    """Keep the host's ``inject_message``, which runs an answer in a session on another platform."""
    global _inject
    _inject = inject_message


def can_inject() -> bool:
    return _inject is not None


def inject(content: str, session_key: str) -> bool:
    """Run ``content`` as a turn in the gateway session ``session_key``. True when the host took it."""
    return _inject is not None and bool(_inject(content, session_key=session_key))


def issue(session: dict) -> str:
    """A fresh context id for one question asked from ``session``: either a cotal session's gateway
    source (chat_id, chat_type, chat_name, user_id, user_name) or ``{"session_key": ...}``."""
    now = time.monotonic()
    token = "hermes-" + secrets.token_hex(16)
    with _lock:
        for old, (_, expires) in list(_issued.items()):
            if expires <= now:
                del _issued[old]
        while len(_issued) >= MAX_QUESTIONS:
            del _issued[next(iter(_issued))]
        _issued[token] = (dict(session), now + TTL_SECONDS)
    return token


def asking_session(context_id: object) -> Optional[dict]:
    """The session that asked the question ``context_id`` names, or None if none here did."""
    if not isinstance(context_id, str):
        return None
    with _lock:
        hit = _issued.get(context_id)
    if hit is None or hit[1] <= time.monotonic():
        return None
    return dict(hit[0])
