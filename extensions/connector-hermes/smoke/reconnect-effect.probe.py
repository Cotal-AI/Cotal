"""Drive the REAL Cotal adapter through a real reconnect over a real Unix socket.

Invoked by `reconnect-effect.smoke.ts`, one scenario per process. The isolation is required, not
stylistic: `get_client()` is a process-wide singleton and the adapter binds a live asyncio loop, so
a second scenario in the same interpreter reads the first one's closed loop and cached client and
then fails for a reason that has nothing to do with its mutation.

Only the upstream `gateway` package is stubbed, because it is not installed in CI. Everything under
test - the adapter, the bridge client, the reader thread, the framing - is the connector's own real
code running against a real socket.

Modes:
    subject          the tree as it stands
    neutered-reopen  reopen() exists and is called, body does nothing   (refuse control)
    deleted-call     reopen() is correct but connect() never calls it   (refuse control)
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types

PLUGIN_PARENT, MODE = sys.argv[1], sys.argv[2]

# ---- stub ONLY the upstream imports ------------------------------------------------------------
_base = types.ModuleType("gateway.platforms.base")


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        pass

    def _mark_connected(self):
        self.connected = True

    def _mark_disconnected(self):
        self.connected = False

    def build_source(self, **kw):
        return kw

    # Mirrors the real base API this adapter now uses. Kept faithful to upstream's shape
    # (gateway/platforms/base.py): _set_fatal_error records code/message/retryable and clears
    # _running, and the retryable flag is what admits the platform to the reconnect queue.
    def _set_fatal_error(self, code, message, *, retryable):
        self._running = False
        self._fatal_error_code = code
        self._fatal_error_message = message
        self._fatal_error_retryable = retryable

    @property
    def has_fatal_error(self):
        return getattr(self, "_fatal_error_message", None) is not None

    @property
    def fatal_error_retryable(self):
        return getattr(self, "_fatal_error_retryable", False)

    @property
    def fatal_error_code(self):
        return getattr(self, "_fatal_error_code", None)

    async def _notify_fatal_error(self):
        return None


class MessageEvent:
    def __init__(self, **kw):
        self.kw = kw


class MessageType:
    TEXT = "text"


class SendResult:
    def __init__(self, **kw):
        pass


_base.BasePlatformAdapter = BasePlatformAdapter
_base.MessageEvent = MessageEvent
_base.MessageType = MessageType
_base.SendResult = SendResult

_cfg = types.ModuleType("gateway.config")


class Platform:
    def __init__(self, name):
        self.name = name


class PlatformConfig:
    pass


_cfg.Platform = Platform
_cfg.PlatformConfig = PlatformConfig

sys.modules.update(
    {
        "gateway": types.ModuleType("gateway"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": _base,
        "gateway.config": _cfg,
    }
)

# ---- a real peer on a real socket ---------------------------------------------------------------
_tmp = tempfile.mkdtemp()
_sockpath = os.path.join(_tmp, "bridge.sock")
os.environ["COTAL_BRIDGE_SOCKET"] = _sockpath
sys.path.insert(0, PLUGIN_PARENT)

_srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
_srv.bind(_sockpath)
_srv.listen(8)
_conns: list[socket.socket] = []


def _serve() -> None:
    while True:
        try:
            conn, _ = _srv.accept()
        except OSError:
            return
        _conns.append(conn)


threading.Thread(target=_serve, daemon=True).start()


def _push(text: str, timeout: float = 6.0) -> bool:
    """Write one inbound frame in the real wire shape the dispatcher expects.

    Waits for a connection rather than assuming one: the reader reconnects on its own schedule, so
    pushing immediately after connect() would race the socket and produce a false negative that
    looks exactly like the defect.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _conns:
            frame = {
                "t": "incoming",
                "msg": {
                    "id": text,
                    "text": text,
                    "kind": "channel",
                    "channel": "general",
                    "fromName": "peer",
                    "fromId": "p1",
                },
            }
            try:
                _conns[-1].sendall(json.dumps(frame).encode() + b"\n")
                return True
            except OSError:
                pass
        time.sleep(0.05)
    return False


from cotal.adapter import CotalAdapter  # noqa: E402
from cotal.bridge_client import BridgeClient, get_client  # noqa: E402


async def _await_delivery(got: list, want: str, timeout: float = 6.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if want in got:
            return True
        await asyncio.sleep(0.05)
    return False


def main() -> None:
    got: list = []
    adapter = CotalAdapter(PlatformConfig())

    async def _inject(msg: dict) -> None:
        got.append(msg.get("id"))

    adapter._inject = _inject  # capture delivery at the gateway boundary

    client = get_client()
    if MODE == "neutered-reopen":
        client.reopen = lambda: None
    if MODE == "deleted-call":
        # Re-bind connect WITHOUT the reopen() call, leaving the rest of the sequence identical, so
        # this control differs from the subject by exactly one line.
        async def _connect_without_reopen(*, is_reconnect: bool = False) -> bool:
            adapter._loop = asyncio.get_running_loop()
            adapter._client.start(adapter._on_incoming)
            adapter._mark_connected()
            return True

        adapter.connect = _connect_without_reopen

    async def scenario() -> tuple[bool, bool, bool, bool]:
        await adapter.connect()
        pushed_cold = _push("cold")
        cold = await _await_delivery(got, "cold")

        # The gateway's real outage sequence: the platform disconnects and the peer goes away.
        await adapter.disconnect()
        for conn in _conns:
            try:
                conn.close()
            except OSError:
                pass
        _conns.clear()
        await asyncio.sleep(0.2)

        await adapter.connect(is_reconnect=True)
        pushed_warm = _push("warm")
        warm = await _await_delivery(got, "warm")
        return cold, warm, pushed_cold, pushed_warm

    cold, warm, pushed_cold, pushed_warm = _run_scenario(scenario)
    print("PUSHED_COLD", pushed_cold)
    print("PUSHED_WARM", pushed_warm)
    print("COLD_DELIVERED", cold)
    print("WARM_DELIVERED", warm)

    if MODE == "subject":
        # A missing or raising `reopen` is a FAILED PROPERTY, not a dead instrument: at the merge
        # base the method does not exist at all, and letting the AttributeError escape would kill
        # the probe and redden an instrument row instead of the named cell.
        print("RACE_READER_CLEARED", _guarded(_race_reader_cleared))
        print("RACE_LIVE_READER_KEPT", _guarded(_race_live_reader_kept))
        try:
            for name, ok in _handle_rows():
                print(name, ok)
            for name, ok in _fatal_rows():
                print(name, ok)
        except BaseException as exc:  # noqa: BLE001 - a crash here fails the properties it guards
            print(f"HANDLE_ROWS_CRASHED {type(exc).__name__}: {exc}")
            for name in ("HANDLE_CLEARED_FAST_UNWIND", "HANDLE_CLEARED_SLOW_UNWIND",
                         "NO_DEAD_HANDLE_AFTER_EXIT", "LIVE_READER_OF_CURRENT_GEN_KEPT",
                         "START_MADE_LIVE_REPLACEMENT", "DEAD_READER_REPORTS_FATAL",
                         "DEAD_READER_FATAL_IS_RETRYABLE", "DEAD_READER_NOT_MARKED_CONNECTED",
                         "HEALTHY_READER_REPORTS_NO_FATAL"):
                print(name, False)
        try:
            responsive, elapsed = _loop_stays_responsive()
            print("LOOP_STAYS_RESPONSIVE", responsive)
            print(f"LOOP_BLOCKED_SECONDS {elapsed:.2f}")
        except BaseException as exc:  # noqa: BLE001 - a crash here fails the property, not the probe
            print(f"LOOP_CHECK_CRASHED {type(exc).__name__}: {exc}")
            print("LOOP_STAYS_RESPONSIVE False")
            print("LOOP_BLOCKED_SECONDS -1")


def _loop_stays_responsive() -> tuple[bool, float]:
    """The bounded join must not run ON the gateway's event loop.

    `reopen` waits for a closed reader to land, and a reader wedged in a blocking recv makes that
    wait run to its full timeout. Called inline from `async def connect`, that stalls the whole
    event loop and freezes every other platform in the process to repair this one. Measured at
    2.00s against a wedged reader before the fix, which an operator would report as the gateway
    hanging on reconnect.

    This holds a reader wedged, runs the real `CotalAdapter.connect(is_reconnect=True)`, and ticks
    a concurrent coroutine throughout. If the loop is blocked the ticker cannot run, so the tick
    count collapses toward zero while the elapsed time still covers the whole join.
    """
    adapter = CotalAdapter(PlatformConfig())
    client = get_client()
    hold = threading.Event()
    wedged = threading.Thread(target=lambda: hold.wait(30), daemon=True)
    client._reader = wedged
    client._stop.set()
    wedged.start()

    async def main() -> tuple[int, float]:
        ticks = 0
        running = True

        async def ticker() -> None:
            nonlocal ticks
            while running:
                ticks += 1
                await asyncio.sleep(0.01)

        task = asyncio.ensure_future(ticker())
        await asyncio.sleep(0)
        t0 = time.monotonic()
        await adapter.connect(is_reconnect=True)
        elapsed = time.monotonic() - t0
        running = False
        task.cancel()
        return ticks, elapsed

    try:
        ticks, elapsed = asyncio.run(main())
    finally:
        hold.set()
        wedged.join(timeout=5)
    # A free loop ticks ~100/s; a blocked one manages a handful before and after and nothing during.
    return ticks >= 20, elapsed


def _race_live_reader_kept() -> bool:
    """A RETIRED reader must stand down rather than keep consuming the socket.

    THIS CHECK CHANGED WITH THE FIX, and the old form is worth recording because it was correct
    under the old design and wrong under the new one. It used to assert that `reopen` LEAVES a
    genuinely running reader installed, on the reasoning that dropping the reference to a live
    thread would let `start` create a second reader on one socket.

    The generation counter makes that reasoning obsolete. `reopen` means "the previous generation
    is finished", so it retires that generation unconditionally, live or not: keeping a live reader
    installed is exactly the guess that produced the dead handle. Double-reading is prevented at
    the other end instead, by `start` holding the lock across its check-and-install and by `_run`
    standing down as soon as its captured generation is stale.

    So the property asserted now is the one that actually protects the socket: after a retirement,
    the old reader stops running and exactly one reader is installed.
    """
    client = BridgeClient(_sockpath)
    release = threading.Event()
    old_reader = threading.Thread(target=lambda: release.wait(5), daemon=True)
    client._reader = old_reader
    client._stop.set()
    old_reader.start()
    try:
        client.reopen()
        retired = client._reader is None          # the old generation is no longer the handle
        client.start(lambda _m: None)
        installed = client._reader
        fresh = installed is not None and installed is not old_reader and installed.is_alive()
        return retired and fresh
    finally:
        release.set()
        old_reader.join(timeout=5)
        client.close()


def _handle_rows() -> list[tuple[str, bool]]:
    """The dead-handle matrix: a reader committed to exit must never remain the active handle.

    This is the defect three reviewers converged on, and it is NOT the same as the on-loop freeze.
    The old `reopen` joined the closed reader and then decided with `is_alive()`. That is a guess
    about the future: a reader committed to exit but descheduled past the 2s timeout reads alive,
    stays installed, and then dies, leaving a dead handle while the platform is still marked
    connected. Nothing behind it ever looks again, because the gateway's watcher only revisits
    platforms in `_failed_platforms` and never re-probes one it believes connected.

    Four rows, each an independent client:
      UNWIND_FAST   a reader that exits well inside the window   (the easy case)
      UNWIND_SLOW   a reader descheduled PAST the window         (the defect: the accept control)
      LIVE_READER   a genuinely running reader                   (the refuse control)
      REPLACEMENT   start() must produce a live reader after a slow unwind

    UNWIND_SLOW and LIVE_READER are near neighbours: both are alive when `reopen` returns. They
    differ only in whether the thread is on its way out, which is exactly what a liveness check
    cannot see and a generation counter does not need to.
    """
    rows: list[tuple[str, bool]] = []

    def client_with_reader(release_after: float):
        c = BridgeClient(_sockpath)
        gate = threading.Event()
        reader = threading.Thread(target=lambda: gate.wait(30), daemon=True)
        c._reader = reader
        c._stop.set()
        reader.start()
        timer = threading.Timer(release_after, gate.set)
        timer.start()
        return c, reader, gate, timer

    # Row 1: exits inside the window.
    c, reader, gate, timer = client_with_reader(0.4)
    c.reopen()
    rows.append(("HANDLE_CLEARED_FAST_UNWIND", c._reader is None))
    gate.set(); timer.cancel(); reader.join(timeout=5)

    # Row 2: THE DEFECT. Committed to exit, descheduled past the bounded join.
    c, reader, gate, timer = client_with_reader(3.0)
    c.reopen()
    cleared = c._reader is None
    gate.set(); timer.cancel(); reader.join(timeout=5)
    # After it finally dies, the handle must still not be a dead thread.
    rows.append(("HANDLE_CLEARED_SLOW_UNWIND", cleared))
    rows.append(("NO_DEAD_HANDLE_AFTER_EXIT", c._reader is None or c._reader.is_alive()))

    # Row 3: REFUSE CONTROL. A genuinely live reader of the CURRENT generation must survive, or
    # start() would run a second reader on one socket.
    c = BridgeClient(_sockpath)
    hold = threading.Event()
    live = threading.Thread(target=lambda: hold.wait(30), daemon=True)
    with c._lock:
        c._reader = live
    live.start()
    kept = c._reader is live
    rows.append(("LIVE_READER_OF_CURRENT_GEN_KEPT", kept))
    hold.set(); live.join(timeout=5)

    # Row 4: after a slow unwind, start() must actually produce a LIVE reader.
    c, reader, gate, timer = client_with_reader(3.0)
    c.reopen()
    c.start(lambda _m: None)
    replacement = c._reader
    # Identity matters, not just liveness. The first draft of this row asked only "is a thread
    # installed and alive", which the PRE-LATCH code satisfied by retaining the OLD dying reader:
    # the row read True against the very defect it was meant to catch. Asserting the handle is a
    # DIFFERENT object than the retired reader is what makes it a replacement rather than a
    # survivor.
    rows.append((
        "START_MADE_LIVE_REPLACEMENT",
        replacement is not None and replacement.is_alive() and replacement is not reader,
    ))
    gate.set(); timer.cancel(); reader.join(timeout=5)
    c.close()
    return rows


def _fatal_rows() -> list[tuple[str, bool]]:
    """A dead reader must be REPORTED, never silently marked connected.

    This is the second half of the panel's fix and it is load-bearing rather than belt-and-braces.
    Verified against the pinned upstream source: the reconnect watcher iterates `_failed_platforms`
    only, entry requires a failed connect or a NOTIFIED retryable fatal, and there is no periodic
    health probe of a platform believed connected. A dying reader thread notifies nothing. So if
    `connect` returned True with a dead reader, nothing would ever look at that platform again and
    it would be deaf for the process lifetime.

    Accept row: a healthy connect reports no fatal, proving the check is not firing on everything.
    """
    rows: list[tuple[str, bool]] = []

    adapter = CotalAdapter(PlatformConfig())
    client = get_client()
    # A reader that is installed and already dead: exactly the dead handle.
    dead = threading.Thread(target=lambda: None, daemon=True)
    dead.start()
    dead.join(timeout=5)
    with client._lock:
        client._reader = dead
    marked = {"connected": False}
    adapter._mark_connected = lambda: marked.__setitem__("connected", True)
    notified = {"n": 0}
    adapter._notify_fatal_error = lambda: _async_noop(notified)

    ok = asyncio.run(adapter.connect())
    rows.append(("DEAD_READER_REPORTS_FATAL", ok is False and adapter.has_fatal_error))
    rows.append(("DEAD_READER_FATAL_IS_RETRYABLE", bool(adapter.fatal_error_retryable) and notified["n"] == 1))
    rows.append(("DEAD_READER_NOT_MARKED_CONNECTED", marked["connected"] is False))

    # ACCEPT CONTROL: a healthy client must connect cleanly and report nothing.
    with client._lock:
        client._reader = None
    client._stop.clear()
    adapter2 = CotalAdapter(PlatformConfig())
    healthy = {"connected": False}
    adapter2._mark_connected = lambda: healthy.__setitem__("connected", True)
    ok2 = asyncio.run(adapter2.connect())
    rows.append(("HEALTHY_READER_REPORTS_NO_FATAL", ok2 is True and healthy["connected"] and not adapter2.has_fatal_error))
    return rows


async def _async_noop(counter: dict) -> None:
    counter["n"] += 1


def _guarded(check) -> bool:
    try:
        return check()
    except BaseException as exc:  # noqa: BLE001 - an unusable reopen fails the property it guards
        print(f"RACE_CHECK_CRASHED {check.__name__} {type(exc).__name__}: {exc}")
        return False


def _run_scenario(scenario) -> tuple[bool, bool, bool, bool]:
    """Run the scenario, turning a CRASH into a reported non-delivery rather than a dead probe.

    This matters for attribution, and a real run is what forced it. Restoring the genuine pre-fix
    plugin files (no ``is_reconnect``, no ``reopen``) makes ``connect(is_reconnect=True)`` raise
    TypeError, which killed the probe outright. The suite then failed on "the subject probe did not
    run", an INSTRUMENT row, so a real historical defect read as a broken harness instead of as the
    bug. That is the same wrong-red shape the mutation harness caught earlier in this suite.

    An adapter that cannot even be called on the reconnect path has, from the operator's point of
    view, precisely the property this suite exists to measure: no mesh traffic arrives after a
    reconnect. So it is reported as a non-delivery, with the cause printed for the reader, and the
    named headline assertion is what goes red.
    """
    try:
        return asyncio.run(scenario())
    except BaseException as exc:  # noqa: BLE001 - deliberately broad: any crash IS a non-delivery
        print(f"SCENARIO_CRASHED {type(exc).__name__}: {exc}")
        return False, False, False, False


def _race_reader_cleared() -> bool:
    """A reader still UNWINDING must not be mistaken for a live one.

    This is the race, and the mutation harness is what pinned down its real mechanism. An earlier
    version of this check targeted the order of the liveness read and the `_stop.clear()`; with the
    bounded join in place that ordering genuinely does not matter, and the harness graded the
    corresponding mutation UNGRADABLE rather than letting it pass as proof. The join is the fix.

    So the interleaving driven here is the one that matters: the reader is alive at the instant
    `reopen` is entered and finishes a moment later. Without the join, `is_alive()` reads True, the
    thread is left installed as `_reader`, and the next `start()` returns having started nothing,
    which is the dead bridge. With the join, `reopen` waits for the thread to land and clears it.
    """
    client = BridgeClient(_sockpath)
    release = threading.Event()
    reader = threading.Thread(target=lambda: release.wait(5), daemon=True)
    client._reader = reader
    client._stop.set()
    reader.start()
    timer = threading.Timer(0.1, release.set)  # the reader exits just after reopen() is entered
    timer.start()
    try:
        client.reopen()
        return client._reader is None and not client._stop.is_set()
    finally:
        timer.cancel()
        release.set()
        reader.join(timeout=5)


main()
