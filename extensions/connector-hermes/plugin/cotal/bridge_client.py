"""Persistent client to the Cotal sidecar's bridge socket.

The sidecar (``src/sidecar.ts``) owns the mesh endpoint and exposes a unix-socket bridge; this is
the in-gateway half. One background thread owns a blocking ``AF_UNIX`` connection and dispatches
frames — inbound mesh messages go to the adapter's callback, tool results resolve pending calls.
Writes are newline-delimited JSON under a lock; it reconnects with backoff so a sidecar restart
self-heals (re-subscribing on every (re)connect). Wire format mirrors ``src/bridge.ts``.
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from typing import Any, Callable, Optional

_BACKOFF_S = 2.0

# How long ``reopen`` waits for a closed reader to finish unwinding. Bounded on purpose: a reader
# wedged in a blocking recv must not hang a reconnect, and leaving it installed is the safe
# outcome, since ``start`` then declines to run a second reader on the same socket.
_REOPEN_JOIN_SECONDS = 2.0


class BridgeClient:
    def __init__(self, socket_path: str) -> None:
        self._path = socket_path
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._pending: dict[str, tuple[threading.Event, dict]] = {}
        self._on_incoming: Optional[Callable[[dict], None]] = None
        self._stop = threading.Event()
        self._reader: Optional[threading.Thread] = None
        # Generation of the CURRENT reader. Bumped by close() and reopen(); each reader captures
        # its own value at birth. A reader whose generation is stale is retired by definition, so
        # correctness never depends on guessing whether a dying thread has finished dying.
        self._gen = 0

    def start(self, on_incoming: Callable[[dict], None]) -> None:
        """Begin the reader thread. ``on_incoming`` is called (off-loop) for each mesh message.

        A reader is started only when none is installed for the CURRENT generation. Holding the
        lock across the check and the install closes the window where two concurrent starts could
        each see None and put two readers on one socket.
        """
        self._on_incoming = on_incoming
        with self._lock:
            if self._reader is not None:
                return
            gen = self._gen
            reader = threading.Thread(target=self._run, args=(gen,), name="cotal-bridge", daemon=True)
            self._reader = reader
        reader.start()

    # ---- reader thread -------------------------------------------------------

    def _run(self, gen: int = 0) -> None:
        """Reader loop for generation ``gen``.

        It stands down when a newer generation exists, so a reader that was slow to notice a close
        cannot keep consuming the socket behind its replacement's back.
        """
        buf = b""
        while not self._stop.is_set() and gen == self._gen:
            if self._sock is None:
                self._connect()
                if self._sock is None:
                    continue
                self._send({"t": "subscribe"})  # (re)subscribe after every (re)connect
            try:
                data = self._sock.recv(65536)
            except OSError:
                data = b""
            if not data:
                with self._lock:
                    self._sock = None
                continue
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    self._dispatch(line)

    def _connect(self) -> None:
        while not self._stop.is_set():
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(self._path)
                with self._lock:
                    self._sock = s
                return
            except OSError:
                time.sleep(_BACKOFF_S)

    def _dispatch(self, line: bytes) -> None:
        try:
            frame = json.loads(line)
        except ValueError:
            return
        t = frame.get("t")
        if t == "incoming":
            cb = self._on_incoming
            if cb:
                cb(frame.get("msg") or {})
        elif t == "tool_result":
            entry = self._pending.get(frame.get("id"))
            if entry:
                entry[1].update(frame)
                entry[0].set()

    # ---- writes --------------------------------------------------------------

    def _send(self, frame: dict) -> None:
        data = (json.dumps(frame) + "\n").encode()
        with self._lock:
            if self._sock is None:
                return
            try:
                self._sock.sendall(data)
            except OSError:
                self._sock = None

    def delivered(self, msg_id: str) -> None:
        """Ack a message on the stream — call only once it has been surfaced into a turn."""
        self._send({"t": "delivered", "id": msg_id})

    def reply(self, target: dict, text: str) -> None:
        """Route a turn's reply back to its mesh origin (channel broadcast or DM to the sender)."""
        self._send({"t": "reply", "target": target, "text": text})

    def call_tool(self, name: str, args: dict, timeout: float = 30.0) -> str:
        """Invoke a cotal_* tool on the sidecar and block for its text result (raises on transport
        error/timeout). The sidecar runs the shared spec, so the text is already model-ready; an
        in-tool logical error comes back flagged and is prefixed for the model."""
        rid = uuid.uuid4().hex
        ev = threading.Event()
        box: dict = {}
        self._pending[rid] = (ev, box)
        try:
            self._send({"t": "tool", "id": rid, "name": name, "args": args})
            if not ev.wait(timeout):
                raise TimeoutError(f"cotal tool '{name}' timed out")
            if not box.get("ok"):
                raise RuntimeError(box.get("error") or "tool failed")
            text = box.get("text") or ""
            return f"⚠ {text}" if box.get("isError") else text
        finally:
            self._pending.pop(rid, None)

    def reopen(self) -> None:
        """Undo a ``close`` so ``start`` can run a new reader thread.

        ``close`` latches ``_stop`` and the reader loop exits on it, but ``_reader`` keeps
        pointing at the finished thread, so a later ``start`` sees a non-None reader and returns
        having started nothing. That yields a platform the gateway believes is connected and which
        receives no mesh traffic at all. The gateway's reconnect watcher builds a fresh adapter but
        ``get_client`` is a process-wide singleton, so the same closed client is what a reconnect
        gets handed. Clearing both here is what makes the restart real.

        WHY A GENERATION COUNTER AND NOT A LIVENESS CHECK. An earlier version joined the closed
        reader and then decided using ``is_alive()``. That is a guess about the future, and a
        reader COMMITTED TO EXIT but descheduled past the timeout answers it wrongly: it reads
        alive, stays installed as the active handle, and then dies, leaving a handle that is dead
        with the platform still marked connected. A timeout cannot distinguish "already gone" from
        "still unwinding", and on the wrong side of that guess there is nothing behind it, because
        the gateway's watcher only ever revisits platforms in ``_failed_platforms`` and never
        re-probes one it believes is connected. Measured: the reader was retained, ``start``
        created no replacement, and the handle was dead moments later.

        The generation counter removes the guess. ``close`` and ``reopen`` both bump ``_gen``, and
        each reader captures its generation at birth. A reader from an older generation is retired
        BY DEFINITION, whatever its current liveness, so it can never be the active handle. The
        bounded join is kept, but only as courtesy: it lets a prompt exit be observed so the common
        case stays tidy. Correctness no longer depends on its outcome.
        """
        with self._lock:
            self._gen += 1
            reader = self._reader
            # Retire the old reader unconditionally: it belongs to a previous generation, so it is
            # not the active handle regardless of whether it has finished unwinding yet.
            self._reader = None
        self._stop.clear()
        if reader is not None:
            # Courtesy only: nothing below depends on whether this returns in time.
            reader.join(timeout=_REOPEN_JOIN_SECONDS)

    def reader_is_dead(self) -> bool:
        """True when a reader was installed and has since died, so the bridge is deaf.

        The adapter reports this to the gateway as a RETRYABLE FATAL. Without it a dead reader is
        invisible: ``connect`` returned True, the platform is marked connected, and the watcher
        only revisits platforms already in ``_failed_platforms``, so nothing would ever look again.
        """
        with self._lock:
            reader = self._reader
        return reader is not None and not reader.is_alive()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            # Retire this generation: any reader still unwinding is already not the active handle.
            self._gen += 1
            if self._sock is not None:
                try:
                    self._sock.close()
                except OSError:
                    pass
                self._sock = None


_client: Optional[BridgeClient] = None


def get_client() -> BridgeClient:
    """Process-wide singleton, bound to ``COTAL_BRIDGE_SOCKET`` (set by the launcher/bootstrap)."""
    global _client
    if _client is None:
        path = os.environ.get("COTAL_BRIDGE_SOCKET")
        if not path:
            raise RuntimeError(
                "COTAL_BRIDGE_SOCKET not set — the Cotal launcher or standalone bootstrap must set it"
            )
        _client = BridgeClient(path)
    return _client
