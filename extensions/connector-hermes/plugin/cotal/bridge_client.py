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


class BridgeClient:
    def __init__(self, socket_path: str) -> None:
        self._path = socket_path
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._pending: dict[str, tuple[threading.Event, dict]] = {}
        self._on_incoming: Optional[Callable[[dict], None]] = None
        self._stop = threading.Event()
        self._reader: Optional[threading.Thread] = None

    def start(self, on_incoming: Callable[[dict], None]) -> None:
        """Begin the reader thread. ``on_incoming`` is called (off-loop) for each mesh message."""
        self._on_incoming = on_incoming
        if self._reader is None:
            self._reader = threading.Thread(target=self._run, name="cotal-bridge", daemon=True)
            self._reader.start()

    # ---- reader thread -------------------------------------------------------

    def _run(self) -> None:
        buf = b""
        while not self._stop.is_set():
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

        Safe to call on a live client: a reader still running is left alone, because dropping the
        reference to a running thread would let ``start`` create a second one on the same socket.
        """
        with self._lock:
            reader = self._reader
            if reader is not None and reader.is_alive():
                self._stop.clear()
                return
            self._reader = None
        self._stop.clear()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
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
