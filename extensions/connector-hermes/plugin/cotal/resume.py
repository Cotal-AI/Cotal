"""Fork a Hermes session for ``cotal spawn --resume`` (launcher side), and seed each mesh chat from
that fork (adapter side).

Hermes' own fork is the gateway's ``/branch``: a new session row whose messages are copied from the
current one, with ``_branched_from`` in its model config. This module does the same copy in two
steps, because the source lives in the operator's profile and the seat runs in its own:

  1. ``fork`` (run by the launcher before the seat joins the mesh) opens the operator's
     ``state.db`` read-only, copies the named session into a new session in the seat's
     ``state.db``, and publishes ``cotal-resume.json`` next to it. The source is only read.
  2. ``seed_chat`` (called by the adapter) gives each mesh chat whose session does not descend from
     that fork a branch of it, the way ``/branch`` does, so the chat's first turn carries the source
     context.

Standalone on purpose: the launcher runs this file as a script, outside the plugin package.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

MARKER = "cotal-resume.json"


def _new_session_id() -> str:
    # Hermes' own shape for a session id (gateway /branch, SessionStore).
    return f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"


def _copy_messages(db: Any, session_id: str, history: list) -> None:
    """Append ``history`` to ``session_id`` with the fields gateway ``/branch`` carries. Unlike
    ``/branch`` a failed row raises: a fork that silently dropped a message would be a truncated
    transcript presented as the source. Hermes before 0.19 stores no ``api_content`` sidecar, so
    there is none to carry and its ``append_message`` takes none."""
    sidecar = None
    if "api_content" in inspect.signature(db.append_message).parameters:
        from agent.turn_context import extract_api_content_sidecar as sidecar
    for msg in history:
        db.append_message(
            session_id=session_id,
            role=msg.get("role", "user"),
            content=msg.get("content"),
            tool_name=msg.get("tool_name") or msg.get("name"),
            tool_calls=msg.get("tool_calls"),
            tool_call_id=msg.get("tool_call_id"),
            finish_reason=msg.get("finish_reason"),
            reasoning=msg.get("reasoning"),
            reasoning_content=msg.get("reasoning_content"),
            reasoning_details=msg.get("reasoning_details"),
            codex_reasoning_items=msg.get("codex_reasoning_items"),
            codex_message_items=msg.get("codex_message_items"),
            **({"api_content": sidecar(msg)} if sidecar else {}),
        )


def fork(source_home: str, source_id: str, seat_home: str) -> dict:
    """Fork ``source_id`` from ``source_home`` into ``seat_home``, or return the seat's existing
    fork of it. Raises ``LookupError`` with the whole diagnosis when it cannot."""
    from hermes_state import SessionDB

    seat = Path(seat_home)
    marker_path = seat / MARKER
    if marker_path.exists():
        # A relaunch continues the seat's own fork and does not read the source again, so the
        # fork outlives the source it came from.
        try:
            marker = json.loads(marker_path.read_text())
        except ValueError as e:
            raise LookupError(f"{marker_path} is not valid JSON ({e}); remove it to fork again") from None
        if marker.get("source") != source_id:
            raise LookupError(
                f"this seat already forked Hermes session {marker.get('source')!r}, not {source_id!r}; "
                "spawn the resume under a new name"
            )
        db = SessionDB(db_path=seat / "state.db")
        try:
            if not db.get_messages_as_conversation(marker["fork"]):
                raise LookupError(f"this seat's fork {marker['fork']!r} of {source_id!r} has no messages in {seat / 'state.db'}")
        finally:
            db.close()
        return {**marker, "created": False}

    source_db = Path(source_home) / "state.db"
    if not source_db.is_file():
        raise LookupError(f"cannot resume Hermes session {source_id!r}: {source_db} does not exist")
    src = SessionDB(db_path=source_db, read_only=True)
    try:
        row = src.get_session(source_id)
        history = src.get_messages_as_conversation(source_id) if row else []
        title = src.get_session_title(source_id) if row else None
    finally:
        src.close()
    if not row:
        raise LookupError(f"cannot resume Hermes session {source_id!r}: no such session in {source_db}")
    if not history:
        raise LookupError(f"cannot resume Hermes session {source_id!r}: it has no messages in {source_db}")

    fork_id = _new_session_id()
    db = SessionDB(db_path=seat / "state.db")
    try:
        db.create_session(
            session_id=fork_id,
            source="cotal",
            model=row.get("model"),
            # The parent lives in another profile's database, so it cannot be parent_session_id
            # (a foreign key into this one). The provenance rides model_config, as /branch does.
            model_config={"_branched_from": source_id, "_cotal_source_home": str(source_home)},
        )
        _copy_messages(db, fork_id, history)
        if title:
            db.set_session_title(fork_id, f"{title} (fork)")
    finally:
        db.close()

    digest = hashlib.sha256(json.dumps(history, sort_keys=True, default=str).encode()).hexdigest()
    marker = {"source": source_id, "fork": fork_id, "title": title, "messages": len(history), "transcriptSha256": digest}
    # Published by rename after the fork is committed, so a torn write never leaves a marker that
    # names a fork, or parses to nothing.
    tmp = marker_path.with_name(f".{MARKER}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(marker))
    os.replace(tmp, marker_path)
    return {**marker, "created": True}


def _descends_from(db: Any, session_id: str, fork_id: str) -> bool:
    """Whether ``session_id`` is ``fork_id`` or follows it through ``parent_session_id``: a branch
    ``seed_chat`` made, or a session Hermes split off one when it compressed the context."""
    seen = set()
    while session_id and session_id not in seen:
        if session_id == fork_id:
            return True
        seen.add(session_id)
        row = db.get_session(session_id)
        session_id = row.get("parent_session_id") if row else None
    return False


def seed_chat(store: Any, source: Any, fork_id: str) -> bool:
    """Branch ``fork_id`` into the chat ``source`` names, unless the chat already holds history that
    descends from this fork. Returns whether it branched. A chat holding history from an earlier seat
    of the same name is switched to the branch too; that history stays in the database under its own
    session. Called on the gateway loop with no await between the check and the switch, so two
    messages for one new chat cannot both branch it."""
    db = getattr(store, "_db", None)
    if db is None:
        raise RuntimeError("the gateway session store has no session database, so the resumed fork cannot be seeded")
    entry = store.get_or_create_session(source)
    # Read through the database, which raises, not store.load_transcript, which returns [] on any
    # error: an unreadable chat taken for an empty one would be switched off its own history.
    if db.get_messages_as_conversation(entry.session_id) and _descends_from(db, entry.session_id, fork_id):
        return False
    history = db.get_messages_as_conversation(fork_id)
    if not history:
        raise RuntimeError(f"the resumed fork {fork_id!r} has no messages, so this chat cannot start from it")
    branch_id = _new_session_id()
    db.create_session(
        session_id=branch_id,
        source="cotal",
        model_config={"_branched_from": fork_id},
        parent_session_id=fork_id,
    )
    _copy_messages(db, branch_id, history)
    if store.switch_session(entry.session_key, branch_id) is None:
        raise RuntimeError(f"could not switch chat {entry.session_key!r} onto its branch of the resumed fork")
    return True


if __name__ == "__main__":
    # fork <source_home> <source_id> <seat_home>: one JSON line on stdout, or the reason on stderr.
    try:
        print(json.dumps(fork(sys.argv[2], sys.argv[3], sys.argv[4])))
    except LookupError as e:
        print(str(e), file=sys.stderr)
        sys.exit(3)
