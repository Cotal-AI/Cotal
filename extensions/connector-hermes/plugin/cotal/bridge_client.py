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
                self._connect(gen)
                # RE-CHECK AFTER THE DIAL, NOT ONLY AT THE TOP OF THE LOOP. `_connect` is fenced,
                # so a reader retired while dialing returns having installed nothing -- but that
                # only means the socket below is not OURS. It does not mean there is no socket:
                # the LIVE generation may have installed its own while we were parked, and the
                # loop condition that would have caught the retirement was evaluated before the
                # dial, not after it. Falling through here reads the live generation's socket and
                # steals its frames, dispatching them into a retired reader's callback. Measured
                # before this re-check: RETIRED_READER_READ_FOREIGN_SOCKET True.
                if self._stop.is_set() or gen != self._gen:
                    return
                if self._sock is None:
                    continue
                self._send({"t": "subscribe"})  # (re)subscribe after every (re)connect
            # Read through a local handle. Re-reading `self._sock` here would race a concurrent
            # reassignment between the guard above and the recv below.
            sock = self._sock
            if sock is None:
                continue
            try:
                data = sock.recv(65536)
            except OSError:
                data = b""
            if not data:
                with self._lock:
                    # CLEAR ONLY WHAT WE OWN. This branch runs on EOF *and* on OSError, which is
                    # how a retired reader is woken: `reopen` shuts the socket down underneath it.
                    # An unguarded `self._sock = None` therefore lets a RETIRED generation erase the
                    # socket the LIVE generation has already installed. Neither existing guard
                    # catches it: the generation check is evaluated at the TOP of the loop, which
                    # this thread has not reached, and the `_connect` fence governs INSTALLING a
                    # socket rather than clearing one. The damage is silent and total: `_send`
                    # returns early when `_sock is None`, so every outbound reply is dropped, and
                    # nothing re-dials on the write path, so the seat stays mute until an inbound
                    # frame happens to wake the reader. Measured before this guard: replies
                    # delivered 0 of 8 with the live socket erased on every rep.
                    if self._sock is sock:
                        self._sock = None
                continue
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    self._dispatch(line)

    def _connect(self, gen: Optional[int] = None) -> None:
        """Dial the bridge socket for generation ``gen``, retrying until connected or stopped.

        THE ASSIGNMENT IS FENCED BY GENERATION, NOT ONLY BY THE LOCK. The lock makes the write
        atomic, which prevents a torn read but says nothing about WHO is writing. A reader that
        entered here before its generation was retired can finish dialing afterwards and install
        its socket over the live generation's, which reproduces the deaf-bridge symptom the
        generation counter exists to eliminate: the new reader ends up reading a socket nobody
        owns while the old one is closed underneath it. Measured before this fence:
        ``STALE_OVERWROTE_LIVE_SOCKET True``.

        Checking the generation under the same lock that guards the assignment closes it, because
        retirement and assignment can no longer interleave between the check and the write. A
        stale dialer closes the socket it just opened rather than leaking it, and returns.

        ``gen`` defaults to None for callers outside the reader loop, which means "unfenced" and
        is only correct before any reader exists.
        """
        while not self._stop.is_set():
            if gen is not None and gen != self._gen:
                return  # retired while dialing: this socket is not wanted
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(self._path)
                with self._lock:
                    if gen is not None and gen != self._gen:
                        # Retired between the dial and the assignment. Close rather than install:
                        # installing here is exactly the clobber this fence exists to prevent.
                        try:
                            s.close()
                        except OSError:
                            pass
                        return
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
            # AND DROP THE SOCKET, which retiring the generation alone does not do. A retired
            # reader is almost always parked in `recv` on this very socket, and a generation check
            # cannot reach a thread blocked in a syscall: it is only evaluated at the TOP of the
            # loop, which the reader reaches after its recv returns. Leaving the socket installed
            # therefore leaves TWO readers on ONE socket, and the next frame is split between them
            # -- the retired one takes a chunk, sees its generation is stale, and exits carrying
            # those bytes, while the installed reader is left holding a fragment that never
            # completes a line. Small frames hide this because they fit in a single recv and so
            # cannot tear. Measured at 100KB before this close: 6 of 8 frames lost, two readers
            # alive on one socket every rep.
            #
            # Shutting down here makes the retirement reach the syscall. AN EARLIER VERSION OF THIS
            # COMMENT CLAIMED `close()` ALONE DID THAT, AND IT WAS WRONG: `close()` drops this
            # object's reference to the open file description, but a thread already blocked in
            # `recv` holds its own, so the description stays open and that read never returns. The
            # delivery cells could not catch the error because a reader stranded forever on a dead
            # socket stops competing for the new one just as well as a reader that exits, so the
            # frames arrived either way and the only trace was a leaked thread per reconnect.
            # `shutdown` acts on the connection rather than the descriptor, so the parked recv
            # returns at once, the retired reader exits without consuming a partial frame, and the
            # replacement dials a socket of its own.
            sock = self._sock
            self._sock = None
        if sock is not None:
            # SHUTDOWN BEFORE CLOSE, because `close()` alone does NOT wake a thread already blocked
            # in `recv` on this socket. `close()` drops THIS object's reference to the file
            # description; the blocked thread still holds its own, so the description stays open and
            # the read never returns. Measured directly on a socketpair: with `close()` alone the
            # reader was still blocked after 3s, and with `shutdown(SHUT_RDWR)` first it returned
            # 0 bytes in 300ms. `shutdown` acts on the connection rather than the descriptor, so it
            # reaches the parked reader.
            #
            # This was a real leak, not a theoretical one: each retired reader stayed parked forever
            # on a socket nobody would ever write to, so every reconnect stranded one more thread.
            # Measured over 6 reopen cycles: bridge threads 1,2,3,4,5,6,7 without the shutdown and
            # flat at 1 with it. The delivery cell could not see this, because a reader stuck
            # forever on a dead socket stops competing for the new one just as effectively as a
            # reader that exits, so frames arrive either way.
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # already disconnected; the close below still frees the descriptor
            try:
                sock.close()
            except OSError:
                pass
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
        """Stop the reader and drop the socket. The adapter's ``disconnect`` path.

        SHUTDOWN BEFORE CLOSE, for the same reason ``reopen`` does it, and the omission here was a
        real leak rather than an asymmetry worth tolerating. ``close()`` drops THIS object's
        reference to the open file description; the reader thread parked in ``recv`` still holds
        its own, so the description stays open and that read never returns. Latching ``_stop`` and
        bumping the generation cannot reach it either: both are only read at the TOP of the loop,
        which a thread blocked in a syscall never gets back to.

        ``reopen`` cannot repair it afterwards, because this method has already set ``_sock`` to
        None and the handle is gone. So every adapter disconnect/reconnect cycle stranded one
        reader thread for the life of the process. Measured over six public
        disconnect/connect(is_reconnect=True) cycles, with each reader proven to have reached its
        blocking read before the disconnect: bridge threads 4,5,6,7,8,9,10 without the shutdown
        and flat at 3 with it, 7 connections accepted either way. The absolute figures carry the
        other cells' own threads, so the cell drains to a stable count before taking its baseline
        and then requires every sample to equal it.

        Every delivery cell is blind to this, which is why it survived five heads: a reader
        stranded forever on a dead socket stops competing for the new socket just as effectively
        as a reader that exits, so frames arrive in both worlds and the thread count is the only
        observable.
        """
        self._stop.set()
        with self._lock:
            # Retire this generation: any reader still unwinding is already not the active handle.
            self._gen += 1
            if self._sock is not None:
                try:
                    self._sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass  # already disconnected, and the close below still frees the descriptor
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
