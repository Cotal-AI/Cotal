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
import inspect
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
            for name, ok in _socket_fence_rows():
                print(name, ok)
            for name, ok in _postdial_rows():
                print(name, ok)
            for name, ok in _last_subscriber_rows():
                print(name, ok)
            for name, ok in _eof_clear_rows():
                print(name, ok)
            for name, ok in _reader_leak_rows():
                print(name, ok)
            for name, ok in _adapter_lifecycle_rows():
                print(name, ok)
        except (KeyboardInterrupt, SystemExit):
            # An interrupt is an ABORT of the measurement, not a property failing. Swallowing it
            # here left the probe running and exiting 0, so the suite graded a cut-off run as a
            # completed one (issue #1591).
            raise
        except BaseException as exc:  # noqa: BLE001 - a crash here fails the properties it guards
            print(f"HANDLE_ROWS_CRASHED {type(exc).__name__}: {exc}")
            for name in ("HANDLE_CLEARED_FAST_UNWIND", "HANDLE_CLEARED_SLOW_UNWIND",
                         "NO_DEAD_HANDLE_AFTER_EXIT", "LIVE_READER_OF_CURRENT_GEN_KEPT",
                         "START_MADE_LIVE_REPLACEMENT", "CONNECT_TAKES_A_GENERATION",
                         "STALE_DIALER_DID_NOT_CLOBBER", "CURRENT_GEN_STILL_INSTALLS",
                         "MIDDIAL_CTOR_RESTORED",
                         "MIDDIAL_PARK_REACHED",
                         "MIDDIAL_RETIRED_DIALER_DID_NOT_CLOBBER",
                         "RETIRED_DIALER_OPENED_NO_CONNECTION",
                         "RETIRED_READER_LEFT_FOREIGN_SOCKET_ALONE",
                         "CURRENT_GEN_READER_STILL_READS",
                         "CLOSE_SHUTS_DOWN_BEFORE_CLOSING",
                         "LARGE_FRAME_SPANS_MULTIPLE_RECVS",
                         "LAST_SUB_WRITER_NEVER_TIMED_OUT",
                         "LAST_SUB_EVERY_REP_DELIVERED",
                         "EOF_LEFT_LIVE_SOCKET_INSTALLED",
                         "EOF_REPLY_STILL_REACHES_BROKER",
                         "RECONNECT_LEAKS_NO_READER_THREAD",
                         "ADAPTER_CYCLE_LEAKS_NO_READER_THREAD",
                         "ADAPTER_CYCLE_DIALLED_EVERY_RECONNECT",
                         "ADAPTER_CYCLE_READER_REACHED_ITS_READ",
                         "DEAD_READER_REPORTS_FATAL",
                         "DEAD_READER_FATAL_IS_RETRYABLE", "DEAD_READER_NOT_MARKED_CONNECTED",
                         "HEALTHY_READER_REPORTS_NO_FATAL"):
                print(name, False)
        try:
            responsive, elapsed = _loop_stays_responsive()
            print("LOOP_STAYS_RESPONSIVE", responsive)
            print(f"LOOP_BLOCKED_SECONDS {elapsed:.2f}")
        except (KeyboardInterrupt, SystemExit):
            raise
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


def _socket_fence_rows() -> list[tuple[str, bool]]:
    """A reader retired mid-dial must not install its socket over the live generation's.

    Found by review, reproduced here before it was fixed. The assignment in `_connect` was already
    under the lock, and that is what makes this easy to miss: the lock makes the write ATOMIC, but
    says nothing about WHO is writing. A reader that entered `_connect` before its generation was
    retired finishes dialing afterwards and installs its socket over the live one, which rebuilds
    the deaf bridge the generation counter exists to eliminate.

    Measured before the fence: STALE_OVERWROTE_LIVE_SOCKET True.

    The accept row is what stops this being a fence that simply refuses everything: the CURRENT
    generation must still dial and install normally.
    """
    rows: list[tuple[str, bool]] = []
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    fence_path = os.path.join(_tmp, "fence.sock")
    srv.bind(fence_path)
    srv.listen(16)

    def _accept_loop() -> None:
        while True:
            try:
                srv.accept()
            except OSError:
                return

    threading.Thread(target=_accept_loop, daemon=True).start()
    try:
        fenced = "gen" in inspect.signature(BridgeClient._connect).parameters
        rows.append(("CONNECT_TAKES_A_GENERATION", fenced))

        client = BridgeClient(fence_path)
        live = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        live.connect(fence_path)
        client._sock = live
        stale_gen = client._gen
        client._gen += 1  # the dialer below is now retired
        client._connect(stale_gen) if fenced else client._connect()
        rows.append(("STALE_DIALER_DID_NOT_CLOBBER", client._sock is live))

        # RETIRED *DURING* THE DIAL, NOT BEFORE IT. The row above bumps the generation and only then
        # calls `_connect`, so the PRE-DIAL check catches it and the under-lock check never runs.
        # Measured consequence: removing either check alone left this suite 52/52 green, so the pair
        # was proven load-bearing while neither half was attributable. This row closes that by
        # retiring the generation while the dial is in flight, which is the window ONLY the
        # under-lock check covers: the pre-dial check has already passed by then.
        midflight = BridgeClient(fence_path)
        live2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        live2.connect(fence_path)
        midflight._sock = live2
        mid_gen = midflight._gen
        in_dial = threading.Event()
        may_finish = threading.Event()
        real_socket_ctor = socket.socket

        dialer_ident: dict = {"id": None}

        def _parking_ctor(*a, _r=real_socket_ctor, **k):
            # Park between the pre-dial check and the assignment: the dialer is past the first
            # guard and has not yet taken the lock.
            #
            # PARK ONLY THE DIALING THREAD. This replaces `socket.socket` process-wide, and earlier
            # cells leave their accept loops running as daemon threads, so a bare "first caller
            # wins" park is a race: another thread's socket() gets parked instead, `in_dial` fires
            # for the wrong caller, and the dialer then runs UNPARKED and installs normally. The
            # row reads False and looks like a product failure. Observed once in seven runs before
            # this guard, which is exactly the kind of intermittent a suite should never ship.
            sk = _r(*a, **k)
            if threading.get_ident() == dialer_ident["id"] and not in_dial.is_set():
                in_dial.set()
                may_finish.wait(5.0)
            return sk

        def _dial() -> None:
            dialer_ident["id"] = threading.get_ident()
            socket.socket = _parking_ctor
            try:
                midflight._connect(mid_gen) if fenced else midflight._connect()
            finally:
                socket.socket = real_socket_ctor

        th = threading.Thread(target=_dial, daemon=True)
        th.start()
        reached = in_dial.wait(5.0)
        ctor_leaked = False
        midflight._gen += 1        # retire it while the dial is parked in flight
        may_finish.set()
        th.join(timeout=5.0)
        # The instrument must be proven to have reached the window, or a pass means nothing.
        # The park replaces `socket.socket` process-wide. Every cell after this one dials through
        # that global, so a patch left installed would quietly corrupt them rather than fail here.
        # The restore lives in the dialing thread's `finally`, which does not run if that thread is
        # still parked, so the leak is asserted rather than assumed.
        ctor_leaked = socket.socket is not real_socket_ctor
        if ctor_leaked:
            socket.socket = real_socket_ctor  # repair before any later cell dials
        rows.append(("MIDDIAL_CTOR_RESTORED", not ctor_leaked))
        rows.append(("MIDDIAL_PARK_REACHED", reached))
        rows.append(("MIDDIAL_RETIRED_DIALER_DID_NOT_CLOBBER", midflight._sock is live2))

        # THE PRE-DIAL CHECK IS AN EARLY-OUT, AND ITS EFFECT IS OBSERVABLE. Removing it leaves the
        # under-lock check to refuse the install, so no delivery cell can see the difference and the
        # half survived every existing row. What DOES change is that the retired dialer opens a
        # connection the broker accepts and nobody ever uses. Measured both ways on this same probe:
        # 0 accepted connections with the check, 1 without it. Graded here so the guard is
        # attributable rather than merely present.
        count_srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        count_path = os.path.join(_tmp, "predial.sock")
        count_srv.bind(count_path)
        count_srv.listen(16)
        accepted = {"n": 0}

        def _count_loop() -> None:
            while True:
                try:
                    count_srv.accept()
                except OSError:
                    return
                accepted["n"] += 1

        threading.Thread(target=_count_loop, daemon=True).start()
        counted = BridgeClient(count_path)
        live3 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        live3.connect(count_path)
        time.sleep(0.2)
        base_n = accepted["n"]
        counted._sock = live3
        stale3 = counted._gen
        counted._gen += 1  # retired BEFORE the dial: the pre-dial check should short-circuit
        counted._connect(stale3) if fenced else counted._connect()
        time.sleep(0.2)
        rows.append(("RETIRED_DIALER_OPENED_NO_CONNECTION", accepted["n"] - base_n == 0))
        print(f"PREDIAL_CONNECTIONS_OPENED {accepted['n'] - base_n}")
        try:
            count_srv.close()
        except OSError:
            pass

        # ACCEPT CONTROL: the live generation still dials and installs.
        fresh = BridgeClient(fence_path)
        fresh._connect(fresh._gen) if fenced else fresh._connect()
        rows.append(("CURRENT_GEN_STILL_INSTALLS", fresh._sock is not None))
    finally:
        try:
            srv.close()
        except OSError:
            pass
    return rows


def _postdial_rows() -> list[tuple[str, bool]]:
    """A reader retired WHILE DIALING must not read the socket it finds on the way out.

    The socket fence stops a stale dialer INSTALLING over the live generation. This is the other
    half, and it survives that fix: a fenced `_connect` returns having installed nothing, which
    means the socket in `_sock` is not ours -- it does NOT mean there is no socket. The live
    generation may have installed its own while we were parked. `_run`'s loop condition was
    evaluated BEFORE the dial, so nothing between the dial and the `recv` notices the retirement,
    and the retired reader consumes frames belonging to its replacement and dispatches them into
    the old callback.

    Measured before the post-dial re-check: RETIRED_READER_READ_FOREIGN_SOCKET True.

    The accept row keeps this from being a guard that simply refuses everything: a reader of the
    CURRENT generation must still read normally after its own dial.
    """
    rows: list[tuple[str, bool]] = []
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    pd_path = os.path.join(_tmp, "postdial.sock")
    srv.bind(pd_path)
    srv.listen(16)

    def _accept_loop() -> None:
        while True:
            try:
                srv.accept()
            except OSError:
                return

    threading.Thread(target=_accept_loop, daemon=True).start()
    try:
        # REFUSE ROW: a retired reader is parked in `_connect`; the live generation installs a
        # socket underneath it; the retired reader must not read that socket.
        client = BridgeClient(pd_path)
        entered = threading.Event()
        released = threading.Event()
        touched = {"foreign": False}
        real_connect = client._connect

        def _gated_connect(gen=None):
            if not entered.is_set():
                entered.set()
                released.wait(5.0)
                return  # the fence: retired while dialing, nothing installed
            return real_connect(gen)

        client._connect = _gated_connect

        class _Watch:
            """Stands in for the LIVE generation's socket and records any read of it.

            THE SHUTDOWN STUB IS PREVENTIVE HERE, NOT LOAD-BEARING, and saying which matters. The
            client this double is installed on is never closed in this cell, so nothing exercises
            the method today and a green run is no evidence that it was needed. It exists because
            the client's socket surface is recv / sendall / shutdown / close, and any future path
            that routes a `close()` through this double would otherwise raise AttributeError from
            inside the client, reddening unrelated rows with something that reads exactly like a
            product defect rather than like a missing stub. Do not delete it as unused: the day it
            is reached is the day the suite lies about why it failed. The call is recorded so a
            cell can assert it if one ever drives that path.
            """

            def __init__(self) -> None:
                self.reads = 0
                self.calls: list[str] = []

            def recv(self, _n: int) -> bytes:
                self.reads += 1
                touched["foreign"] = True
                time.sleep(0.2)
                return b""

            def sendall(self, _b: bytes) -> None:
                return None

            def shutdown(self, how: int) -> None:
                self.calls.append(f"shutdown:{how}")

            def close(self) -> None:
                self.calls.append("close")

        client.start(lambda _m: None)
        entered.wait(5.0)
        client.reopen()                      # retire the parked reader
        with client._lock:
            client._sock = _Watch()          # the live generation's socket
        released.set()
        time.sleep(1.2)
        rows.append(("RETIRED_READER_LEFT_FOREIGN_SOCKET_ALONE", not touched["foreign"]))

        # ACCEPT ROW: a CURRENT-generation reader still reads after its own dial. Without this the
        # row above passes for a reader that never reads anything at all.
        live = BridgeClient(pd_path)
        seen = {"reads": 0}

        class _Counting:
            """The live generation's socket, counting reads and recording the close sequence.

            THIS DOUBLE'S SHUTDOWN STUB IS LOAD-BEARING, unlike `_Watch`'s. `live.close()` below is
            a real product close on the client holding this object, so once `close()` shuts the
            socket down before closing it, a double without the method raises AttributeError from
            inside the client and flips unrelated rows in this cell. The full surface the client
            uses is recv / sendall / shutdown / close, so the full surface is implemented, and the
            ORDER is recorded rather than discarded so a cell can assert the shutdown really
            preceded the close instead of trusting that the method merely exists.
            """

            def __init__(self) -> None:
                self.calls: list[str] = []

            def recv(self, _n: int) -> bytes:
                seen["reads"] += 1
                time.sleep(0.2)
                return b""

            def sendall(self, _b: bytes) -> None:
                return None

            def shutdown(self, how: int) -> None:
                self.calls.append(f"shutdown:{how}")

            def close(self) -> None:
                self.calls.append("close")

        counting = _Counting()

        def _install(gen=None):
            with live._lock:
                live._sock = counting

        live._connect = _install
        live.start(lambda _m: None)
        time.sleep(1.0)
        rows.append(("CURRENT_GEN_READER_STILL_READS", seen["reads"] > 0))
        live.close()
        # GRADED ON THE SEQUENCE, NOT ON THE PRESENCE OF A METHOD. `close()` must shut the
        # connection down before releasing the descriptor, because only the shutdown reaches a
        # reader already parked in `recv`. Recording the calls in order is what separates "the
        # product called shutdown" from "the double happens to own a shutdown method".
        rows.append((
            "CLOSE_SHUTS_DOWN_BEFORE_CLOSING",
            counting.calls[:2] == [f"shutdown:{socket.SHUT_RDWR}", "close"],
        ))
        print(f"CLOSE_CALL_SEQUENCE {','.join(counting.calls) or 'none'}")
    finally:
        try:
            srv.close()
        except OSError:
            pass
    return rows


_LARGE_FRAME_BYTES = 100 * 1024
_WRITER_DEADLINE_S = 10.0
_LAST_SUB_REPS = 8


def _bounded_write(sock, payload: bytes) -> bool:
    """sendall on a worker thread with a deadline. True when the whole payload left.

    NEVER a bare sendall on this path. A 100 KB frame exceeds `wmem_default` (212992 here, but the
    margin is not the point), so a write to an AF_UNIX peer that nobody is draining blocks in the
    kernel forever and hangs the probe instead of failing the cell. A writer that times out is a
    FAILED CELL, not a stalled suite.
    """
    done: list[bool] = []

    def _w() -> None:
        try:
            sock.sendall(payload)
            done.append(True)
        except OSError:
            done.append(False)

    t = threading.Thread(target=_w, daemon=True)
    t.start()
    t.join(_WRITER_DEADLINE_S)
    return bool(done) and done[0]


def _last_subscriber_rows() -> list[tuple[str, bool]]:
    """The duplicate subscriber a retired reader leaves behind, graded on a frame that TEARS.

    The shape. After `reopen()`, a retired generation can still be inside `_connect`. It declines
    to install under the fence, falls through in `_run`, and subscribes again -- so the broker sees
    a SECOND subscriber on the same socket, and that duplicate is the LAST one it registered. A
    frame written to that last subscriber must still be dispatched by the reader that is actually
    installed, not swallowed by the retired one.

    WHY 100 KB AND NOT THE 134 BYTES THIS PROBE USED EVERYWHERE ELSE. A 134-byte frame fits in one
    `recv(65536)` and therefore cannot tear: it is delivered whole or not at all, so a reader that
    takes one chunk and stands down looks identical to a reader that never ran. At 100 KB the frame
    spans MORE THAN ONE recv, so a retired reader that consumes the first chunk and then exits
    leaves the installed reader holding a fragment that never completes a line, and the message is
    lost rather than merely delayed. That is the loss the shipped connector shows and this probe's
    frame size could not reach.

    Every rep is asserted, not just the last: an intermittent tear that heals on rep 8 is still a
    lost message on rep 3.
    """
    rows: list[tuple[str, bool]] = []
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    ls_path = os.path.join(_tmp, "lastsub.sock")
    srv.bind(ls_path)
    srv.listen(16)
    side: dict = {"subs": []}

    def _accept_loop() -> None:
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            side["subs"].append(c)

    threading.Thread(target=_accept_loop, daemon=True).start()

    delivered = 0
    writer_ok = 0
    try:
        for rep in range(_LAST_SUB_REPS):
            got: list[str] = []
            seen = threading.Event()

            def _on_incoming(msg: dict, _got=got, _seen=seen) -> None:
                _got.append(msg.get("id") or "")
                _seen.set()

            # BOTH PARKING PATHS, ALTERNATING BY REP, BECAUSE THEY ARE DIFFERENT DEFECTS AND EACH
            # SHAPE IS BLIND TO THE OTHER. Measured, not assumed:
            #   parked in `recv`     -> covers the reopen socket close (M9), blind to the re-check
            #                           (deleting the re-check still delivered 8 of 8)
            #   parked in `_connect` -> covers the post-dial re-check (M8), blind to the close
            #                           (deleting the close still delivered 8 of 8)
            # Running only one shape buys one kill and silently drops the other, which is how the
            # first version of this cell passed against the very defect it was named for.
            park_in_dial = rep % 2 == 1
            client = BridgeClient(ls_path)
            entered = threading.Event()
            released = threading.Event()
            real_connect = client._connect

            if park_in_dial:
                # The state only the post-dial re-check guards: `_connect` returns under the fence
                # having installed nothing, and the retired reader is then one line away from
                # recv()ing the LIVE generation's socket and eating a chunk of this frame.
                def _park(gen=None, _e=entered, _r=released, _rc=real_connect):
                    if not _e.is_set():
                        _e.set()
                        _r.wait(5.0)
                        return  # fenced: retired mid-dial, nothing installed
                    return _rc(gen)

                client._connect = _park
                client.start(_on_incoming)
                entered.wait(5.0)
                client.reopen()
                client._connect = real_connect
                client.start(_on_incoming)
                deadline = time.time() + 5.0
                while not side["subs"] and time.time() < deadline:
                    time.sleep(0.02)
                released.set()  # let the retired dialer return into the fall-through
                time.sleep(0.2)
            else:
                # The state only the reopen socket close reaches: the retired reader is blocked in
                # `recv` on the installed socket, where a generation check cannot reach it.
                client.start(_on_incoming)
                deadline = time.time() + 5.0
                while not side["subs"] and time.time() < deadline:
                    time.sleep(0.02)
                client.reopen()
                client.start(_on_incoming)
                deadline = time.time() + 5.0
                while len(side["subs"]) < 2 and time.time() < deadline:
                    time.sleep(0.02)

            # Write ONE large frame to the LAST subscriber the broker registered.
            target = side["subs"][-1]
            ident = f"large-{rep}"
            pad = "x" * (_LARGE_FRAME_BYTES - 120)
            frame = json.dumps({"t": "incoming", "msg": {"id": ident, "pad": pad}}).encode() + b"\n"
            wrote = _bounded_write(target, frame)
            writer_ok += 1 if wrote else 0
            if wrote and seen.wait(6.0) and ident in got:
                delivered += 1
            client.close()
            for c in side["subs"]:
                try:
                    c.close()
                except OSError:
                    pass
            side["subs"].clear()

        # Stable row NAMES with the counts carried in separate rows. A name that embeds its own
        # count (LAST_SUB_DELIVERED_7_OF_8) renames itself the moment it fails, so the suite's
        # lookup misses and the cell reads as absent rather than red. The denominator is still
        # printed, just not as part of the key.
        rows.append(("LARGE_FRAME_SPANS_MULTIPLE_RECVS", _LARGE_FRAME_BYTES > 65536))
        rows.append(("LAST_SUB_WRITER_NEVER_TIMED_OUT", writer_ok == _LAST_SUB_REPS))
        rows.append(("LAST_SUB_EVERY_REP_DELIVERED", delivered == _LAST_SUB_REPS))
        print(f"LAST_SUB_FRAME_BYTES {_LARGE_FRAME_BYTES}")
        print(f"LAST_SUB_WRITER_OK {writer_ok} of {_LAST_SUB_REPS}")
        print(f"LAST_SUB_DELIVERED {delivered} of {_LAST_SUB_REPS}")
    finally:
        try:
            srv.close()
        except OSError:
            pass
    return rows


_EOF_REPS = 8


def _eof_clear_rows() -> list[tuple[str, bool]]:
    """The EOF path erases the LIVE socket, so replies are dropped until an inbound wakes a redial.

    The shape. `_run` now reads through a local handle, so a retired generation recv()s the socket
    it actually had. But the EOF branch clears the SHARED field unconditionally:

        if not data:
            with self._lock:
                self._sock = None

    That write is not guarded by identity. Sequence, all on one client:

      1. gen0's reader is parked in `recv` on s0.
      2. `reopen()` retires gen0 and closes s0, then `start()` installs gen1, which dials s1.
      3. gen0's parked `recv` returns EOF (b"") because s0 was closed. That is the CORRECT wakeup,
         and it is exactly what the M9 close was added to cause.
      4. gen0 then executes `self._sock = None`, erasing **s1**, which it never owned.

    The generation check cannot save this: it is evaluated at the TOP of the loop, and the clear
    happens before the thread gets back there. The socket fence cannot save it either, because the
    fence governs INSTALLING a socket, not clearing one.

    Why it is a real outage rather than a cosmetic nil. `_send` returns early when `_sock is None`,
    so every outbound reply is silently dropped. Nothing re-dials on the write path: only `_run`
    dials, and it only does so when it next reaches the top of its loop. The live reader is by then
    parked in `recv` on a socket it still holds locally, so it will not notice until an INBOUND
    frame arrives. A seat that is asked a question and answers it therefore answers into a void.

    Graded on `reply()` because that is the observable behaviour, not on the private field.

    Both parking shapes alternate by rep, for the same reason the last-subscriber cell does: the
    EOF wakeup is reachable only when the retired reader is parked in `recv` (shape A), so a cell
    that only parked in `_connect` would never execute the clear at all and would pass green
    against the defect it is named for. Shape B is kept so the cell still covers the case where the
    retired reader is mid-dial and the EOF never fires, which must ALSO leave the live socket alone.
    """
    rows: list[tuple[str, bool]] = []
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    eof_path = os.path.join(_tmp, "eofclear.sock")
    srv.bind(eof_path)
    srv.listen(16)
    side: dict = {"subs": []}

    def _accept_loop() -> None:
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            side["subs"].append(c)

    threading.Thread(target=_accept_loop, daemon=True).start()

    replies_out = 0
    sock_live = 0
    try:
        for rep in range(_EOF_REPS):
            park_in_dial = rep % 2 == 1
            client = BridgeClient(eof_path)
            entered = threading.Event()
            released = threading.Event()
            real_connect = client._connect

            if park_in_dial:
                def _park(gen=None, _e=entered, _r=released, _rc=real_connect):
                    if not _e.is_set():
                        _e.set()
                        _r.wait(5.0)
                        return
                    return _rc(gen)

                client._connect = _park
                client.start(lambda _m: None)
                entered.wait(5.0)
                client.reopen()
                client._connect = real_connect
                client.start(lambda _m: None)
                deadline = time.time() + 5.0
                while not side["subs"] and time.time() < deadline:
                    time.sleep(0.02)
                released.set()
                time.sleep(0.3)
            else:
                # Shape A: gen0 parked in recv on s0. reopen() closes s0 so that recv returns EOF.
                #
                # THE INTERLEAVING HAS TO BE FORCED, and saying why matters more than the code. The
                # EOF clear is only destructive if gen1's socket is ALREADY INSTALLED when gen0 runs
                # it. reopen() sets `_sock = None` itself and then joins the old reader for up to
                # _REOPEN_JOIN_SECONDS, so in the common case gen0 wakes, clears a field that is
                # already None, and exits before start() installs s1. Harmless, and that is why a
                # naive version of this cell passes 8 of 8 against the live defect.
                #
                # The damaging order is the one where gen0 is DESCHEDULED past the courtesy join:
                # it is a bounded wait, not a barrier, and the comment in reopen() says correctness
                # must not depend on its outcome. So this holds gen0 between its EOF wakeup and its
                # clear, installs s1, and only then releases it. That is a real schedule, not a
                # synthetic one: a 2s join expiring under load is precisely the case the generation
                # counter exists to survive.
                # A real `socket` object refuses attribute assignment ('recv' is read-only), so the
                # hold is installed as a thin WRAPPER that `_sock` accepts: the client only ever
                # calls recv / sendall / close on it. An earlier version of this cell patched the
                # socket directly, swallowed the AttributeError, and passed 8 of 8 against the live
                # defect because the hold never attached at all.
                at_eof = threading.Event()
                may_clear = threading.Event()

                class _HoldAtEOF:
                    """Pass-through socket that parks the reader between its EOF and its clear."""

                    def __init__(self, inner):
                        self._inner = inner
                        self._held = False

                    def recv(self, n):
                        # THE WAKEUP IS AN EXCEPTION, NOT A ZERO-BYTE RETURN. reopen() CLOSES the
                        # socket, so the parked recv raises OSError; it does not return b"". `_run`
                        # catches that and sets `data = b""`, falling into the very same unguarded
                        # clear. A version of this hold that only fired on the b"" return never
                        # triggered at all and reported 8 of 8 against the live defect. Both paths
                        # are held, and the raise is re-raised so the client sees normal behaviour.
                        try:
                            out = self._inner.recv(n)
                        except OSError:
                            if not self._held:
                                self._held = True
                                at_eof.set()
                                may_clear.wait(5.0)
                            raise
                        if not out and not self._held:
                            self._held = True
                            at_eof.set()       # EOF observed, the clear has NOT run yet
                            may_clear.wait(5.0)  # hold while gen1 installs s1
                        return out

                    def sendall(self, data):
                        return self._inner.sendall(data)

                    def shutdown(self, how):
                        # The double must implement the WHOLE surface the client uses. `reopen`
                        # shuts the socket down before closing it, and a double missing this method
                        # raises AttributeError from inside the client, which reddens unrelated rows
                        # and hides the cell this stands in for.
                        return self._inner.shutdown(how)

                    def close(self):
                        return self._inner.close()

                # THE WRAPPER HAS TO BE INSTALLED BEFORE start(), NOT AFTER IT. `_run` reads
                # through a LOCAL handle (`sock = self._sock`, the race fix this PR already
                # shipped), so a reader that has already dialled is holding the RAW socket and
                # never calls through a wrapper swapped into the field behind it. Wrapping after
                # start() left the hold unreachable: traced, the wrapper's recv was never called
                # once, and only reopen()'s close touched it. So gen0's dial is wrapped at source.
                real_connect_a = client._connect

                def _wrap_after_dial(gen=None, _rc=real_connect_a, _c=client):
                    _rc(gen)
                    with _c._lock:
                        if _c._sock is not None and not isinstance(_c._sock, _HoldAtEOF):
                            _c._sock = _HoldAtEOF(_c._sock)

                client._connect = _wrap_after_dial
                client.start(lambda _m: None)
                deadline = time.time() + 5.0
                while not side["subs"] and time.time() < deadline:
                    time.sleep(0.02)
                # gen1 must dial a REAL socket, so the wrapping dialer is retired first.
                client._connect = real_connect_a
                if not isinstance(client._sock, _HoldAtEOF):
                    at_eof.set()  # never wrapped; do not deadlock the cell

                client.reopen()
                at_eof.wait(5.0)
                client.start(lambda _m: None)
                deadline = time.time() + 5.0
                while len(side["subs"]) < 2 and time.time() < deadline:
                    time.sleep(0.02)
                # Release gen0 into its clear and then measure AT ONCE. The 0.4s settle this cell
                # first used was itself a bug: with the socket erased, the LIVE reader reaches the
                # top of its loop, sees `_sock is None` and RE-DIALS, so the outage self-heals
                # inside the settle and the row graded the heal instead of the damage. A seat that
                # has just been asked a question answers immediately, which is exactly the window
                # the erase lands in.
                may_clear.set()
                time.sleep(0.05)

            # Observable grading: can the seat still SPEAK? Count bytes the broker actually reads.
            target = side["subs"][-1] if side["subs"] else None
            if client._sock is not None:
                sock_live += 1
            # GRADE BY CONTENT, NOT BY BYTE COUNT. Reading "some bytes arrived" off this socket
            # counts the client's own `{"t": "subscribe"}` frame as if it were the reply: measured
            # directly, erasing `_sock` and replying at once still put 19 bytes on the wire, and
            # every one of them was the subscribe. The reply itself was dropped exactly as the
            # defect predicts. A cell that greps for bytes therefore reports the outage as healthy.
            # Drain until the reply's own marker is seen or the socket goes quiet.
            saw_reply = False
            if target is not None:
                marker = ("eof-probe-%d" % rep).encode()
                client.reply({"kind": "dm", "to": "eof-probe-%d" % rep}, "hello")
                target.settimeout(0.6)
                pending = b""
                deadline_r = time.time() + 1.5
                while time.time() < deadline_r:
                    try:
                        chunk = target.recv(65536)
                    except (OSError, socket.timeout):
                        break
                    if not chunk:
                        break
                    pending += chunk
                    if marker in pending and b'"reply"' in pending:
                        saw_reply = True
                        break
            replies_out += 1 if saw_reply else 0

            client.close()
            for c in side["subs"]:
                try:
                    c.close()
                except OSError:
                    pass
            side["subs"].clear()

        rows.append(("EOF_LEFT_LIVE_SOCKET_INSTALLED", sock_live == _EOF_REPS))
        rows.append(("EOF_REPLY_STILL_REACHES_BROKER", replies_out == _EOF_REPS))
        print(f"EOF_SOCK_LIVE {sock_live} of {_EOF_REPS}")
        print(f"EOF_REPLIES_DELIVERED {replies_out} of {_EOF_REPS}")
    finally:
        try:
            srv.close()
        except OSError:
            pass
    return rows


# Read from source at HEAD, not guessed: bridge_client.py line 53 names the reader thread.
_READER_THREAD_NAME = "cotal-bridge"
_LEAK_CYCLES = 6


def _reader_leak_rows() -> list[tuple[str, bool]]:
    """Every reconnect must retire its reader thread, not strand it in a blocked read.

    `close()` on a socket does NOT wake a thread already blocked in `recv` on it. It drops this
    object's reference to the open file description; the blocked thread still holds its own, so the
    description stays open and the read never returns. Measured on a bare socketpair: with `close()`
    alone the reader was still blocked after 3s, and with `shutdown(SHUT_RDWR)` first it returned 0
    bytes in 300ms.

    Why the delivery cells are blind to it. A reader stuck forever on a dead socket stops competing
    for the new socket's frames just as effectively as a reader that exits, so every delivery cell
    stays green either way. The only visible difference is the thread, which is why this is graded
    by counting threads rather than messages. Left unfixed, a long-lived seat strands one reader per
    reconnect: measured 1,2,3,4,5,6,7 over six cycles before the shutdown, flat at 1 after it.
    """
    rows: list[tuple[str, bool]] = []
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    leak_path = os.path.join(_tmp, "leak.sock")
    srv.bind(leak_path)
    srv.listen(64)
    subs: list = []

    def _accept_loop() -> None:
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            subs.append(c)

    threading.Thread(target=_accept_loop, daemon=True).start()

    def _bridge_threads() -> int:
        return sum(1 for t in threading.enumerate() if t.name == _READER_THREAD_NAME and t.is_alive())

    client = BridgeClient(leak_path)
    try:
        client.start(lambda _m: None)
        deadline = time.time() + 5.0
        while not subs and time.time() < deadline:
            time.sleep(0.02)
        baseline = _bridge_threads()
        counts = [baseline]
        for _ in range(_LEAK_CYCLES):
            client.reopen()
            client.start(lambda _m: None)
            time.sleep(0.25)
            counts.append(_bridge_threads())
        # GRADE GROWTH, NOT THE ABSOLUTE COUNT. Earlier cells in this probe leave their own bridge
        # threads alive, so the absolute number is not 1 here and asserting `<= 1` fails for a
        # reason that has nothing to do with this defect. What this cell owns is whether EACH
        # RECONNECT adds one: the leak is strictly monotonic, one per cycle, so growth over the
        # baseline is the signal and the baseline itself is noise from other cells.
        growth = max(counts) - baseline
        rows.append(("RECONNECT_LEAKS_NO_READER_THREAD", growth == 0))
        print(f"BRIDGE_THREADS_PER_CYCLE {','.join(str(x) for x in counts)}")
        print(f"BRIDGE_THREADS_BASELINE {baseline}")
        print(f"BRIDGE_THREADS_GROWTH {max(counts) - baseline} over {_LEAK_CYCLES} cycles")
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001 - teardown must not mask the rows
            pass
        for c in subs:
            try:
                c.close()
            except OSError:
                pass
        try:
            srv.close()
        except OSError:
            pass
    return rows


_ADAPTER_CYCLES = 6
_ADAPTER_DIALS = _ADAPTER_CYCLES + 1  # the cold connect, plus one per reconnect
_STEADY_STATE_DEADLINE_S = 3.0
_PARK_DEADLINE_S = 5.0
_DRAIN_DEADLINE_S = 5.0


def _adapter_lifecycle_rows() -> list[tuple[str, bool]]:
    """The same leak through the PUBLIC adapter lifecycle, which is the path an operator drives.

    WHY A SECOND THREAD CELL RATHER THAN A WIDER ONE. The reader-leak cell above drives `reopen()`
    directly, so it grades the socket shutdown `reopen` performs and is blind to `close()`. The
    gateway never calls `reopen` on its own: it calls `disconnect`, which calls `BridgeClient.close`,
    and `close` had no shutdown at all. `reopen` cannot repair that afterwards either, because
    `close` has already set `_sock` to None and the handle is gone. So the defect this cell exists
    for lives entirely on the public path, and no cell in this suite reached it: measured over six
    disconnect/connect(is_reconnect=True) cycles, bridge threads 1,2,3,4,5,6,7 with 7 connections
    accepted, against 1,1,1,1,1,1,1 and the same 7 accepted once `close` shuts the socket down.

    TWO ROWS, BECAUSE A THREAD COUNT ALONE CANNOT TELL A FIX FROM AN OUTAGE. A build whose reconnect
    never happens leaks nothing, so growth reads 0 (measured -1 on a no-op `reopen`, which is why
    this asserts `== 0` and not `<= 0`) while only ONE connection is ever accepted. Asserting the
    dials as well is what makes the green mean "seven real reconnects, no stranded readers" rather
    than "nothing ran".

    SAMPLED AT STEADY STATE WHILE CONNECTED, NEVER IN THE DISCONNECTED WINDOW. A sample taken
    between `disconnect` and `connect` reads a reader that is mid-exit, which on a loaded runner
    gives spurious growth on CORRECT code. The settle below is a bounded POLL rather than a fixed
    sleep, and it can only ever forgive a TRANSIENT overlap: a stranded reader is parked in `recv`
    forever, so waiting cannot make a real leak disappear, it can only let a dying thread finish
    dying.

    GRADED AS EVERY CONNECTED SAMPLE EQUAL TO THE FIRST, after a drain, and both halves are needed.
    Two subtraction metrics were tried first and each has its own blind spot: final minus first
    passes a dip that returns (5,3,3,3,3,3,5), final minus the lowest sample passes a monotone
    decline (5,4,3,2,2,2,2), and BOTH pass a bump that is reaped before the end
    (5,9,9,9,9,9,5), which is six threads leaked and then collected. Requiring every sample to
    equal the baseline reds all three, and costs nothing on a correct build, where every sample IS
    the baseline.

    THE DRAIN IS NOT OPTIONAL UNDER THAT METRIC. Earlier cells in this probe leave their own bridge
    threads alive and still dying when this cell starts, so an undrained baseline is contaminated:
    measured 5,4,4,5,6,7,8 on the pre-fix control, where the first sample sat above the true floor.
    Under a subtraction that quietly rescored; under this metric it would RED ON CORRECT CODE and
    look exactly like a product leak. So the count is first polled to stability (unchanged across
    two consecutive reads, with a deadline, never a fixed sleep) and only then is the baseline
    taken.

    THE PARK IS FORCED AND PROVEN, NOT ASSUMED, and this is what the cell got wrong first. The leak
    only exists for a reader that is ALREADY BLOCKED IN `recv` when `close()` runs: a reader still
    dialing, or between its dial and its first read, sees the latched stop flag at the top of its
    loop and exits cleanly, leaking nothing. A cycle that disconnects too quickly therefore measures
    a defect-free build, and it does so SILENTLY. Measured on the pre-fix control: with no wait the
    series read 4,4,4,4,4,4,4, a confident green against the live defect, while the same control
    with the park forced read a strictly growing series. So each cycle waits for the broker to
    accept the dial AND for the reader's own `{"t": "subscribe"}` frame to arrive, which is the last
    thing `_run` does before it blocks in `recv`. That every cycle reached the park is asserted as
    its own row, because a park that never happened would otherwise produce a pass.

    Whether the leak is observable WITHOUT forcing the park depends on event-loop scheduling: the
    adapter path puts an await and a thread hop between `close()` and the replacement's first read,
    which gives the retired reader more chance to observe the latch and exit. A cell whose
    sensitivity varies by host and load is the intermittent this suite exists to remove, which is
    why the precondition is made explicit rather than left accidental.
    """
    rows: list[tuple[str, bool]] = []
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    life_path = os.path.join(_tmp, "lifecycle.sock")
    srv.bind(life_path)
    srv.listen(64)
    accepted = {"n": 0}
    subs: list = []

    def _accept_loop() -> None:
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            accepted["n"] += 1
            c.settimeout(_PARK_DEADLINE_S)
            subs.append(c)

    threading.Thread(target=_accept_loop, daemon=True).start()

    def _bridge_threads() -> int:
        return sum(1 for t in threading.enumerate() if t.name == _READER_THREAD_NAME and t.is_alive())

    def _settled(floor: int) -> int:
        """Poll until the bridge-thread count is back at `floor`, or the deadline expires."""
        deadline = time.time() + _STEADY_STATE_DEADLINE_S
        n = _bridge_threads()
        while n > floor and time.time() < deadline:
            time.sleep(0.05)
            n = _bridge_threads()
        return n

    def _drained() -> int:
        """Poll until the count stops moving, so the baseline is this cell's and not the last one's.

        Stability across two consecutive reads, with a deadline, rather than a fixed sleep: the
        threads being waited out belong to earlier cells and their exit time is not knowable from
        here. A deadline that expires simply yields the current count, which the strict row below
        will then judge; it cannot silently rescore anything.
        """
        deadline = time.time() + _DRAIN_DEADLINE_S
        prev = _bridge_threads()
        while time.time() < deadline:
            time.sleep(0.1)
            cur = _bridge_threads()
            if cur == prev:
                return cur
            prev = cur
        return prev

    def _await_park(want: int) -> bool:
        """Wait until dial `want` is accepted and its reader has reached its blocking read.

        The reader's LAST act before blocking in `recv` is to write `{"t": "subscribe"}`, so
        reading that frame off the broker's end is the proof that the park was reached. Anything
        weaker (a sleep, or the accept alone) lets the cycle close a reader that has not blocked
        yet, which exits cleanly and leaks nothing even on the defective build.
        """
        deadline = time.time() + _PARK_DEADLINE_S
        while len(subs) < want and time.time() < deadline:
            time.sleep(0.02)
        if len(subs) < want:
            return False
        try:
            return b"subscribe" in subs[want - 1].recv(65536)
        except (OSError, socket.timeout):
            return False

    adapter = CotalAdapter(PlatformConfig())
    # A CLIENT OF THIS CELL'S OWN, on this cell's own socket, and the reason is not tidiness.
    # `get_client()` is a process-wide singleton that earlier cells have already dialled, retired
    # and closed, so its accept count is not attributable to this cell and its reader history is
    # not this cell's. The adapter methods under test are the REAL ones; only the socket the client
    # dials is this cell's.
    client = BridgeClient(life_path)
    adapter._client = client
    counts: list[int] = []
    parked = 0
    try:
        # DRAIN BEFORE THE BASELINE, so the figure every later sample is compared against belongs
        # to this cell. Earlier cells' readers are still dying at this point.
        drained = _drained()

        async def _cycle() -> None:
            nonlocal parked
            await adapter.connect()
            parked += 1 if await asyncio.to_thread(_await_park, 1) else 0
            # Baseline is taken with the platform CONNECTED and its reader parked in its read, so
            # the figure the later samples are compared against is one live, blocked reader.
            counts.append(_bridge_threads())
            for cycle in range(_ADAPTER_CYCLES):
                await adapter.disconnect()      # the product path: BridgeClient.close()
                await adapter.connect(is_reconnect=True)
                parked += 1 if await asyncio.to_thread(_await_park, cycle + 2) else 0
                counts.append(_settled(counts[0]))

        asyncio.run(_cycle())
        baseline = counts[0]
        rows.append(("ADAPTER_CYCLE_LEAKS_NO_READER_THREAD", all(n == baseline for n in counts)))
        rows.append(("ADAPTER_CYCLE_DIALLED_EVERY_RECONNECT", accepted["n"] == _ADAPTER_DIALS))
        rows.append(("ADAPTER_CYCLE_READER_REACHED_ITS_READ", parked == _ADAPTER_DIALS))
        print(f"ADAPTER_CYCLE_THREADS_PER_CYCLE {','.join(str(x) for x in counts)}")
        print(f"ADAPTER_CYCLE_THREADS_BASELINE {baseline}")
        print(f"ADAPTER_CYCLE_THREADS_DRAINED_TO {drained}")
        print(f"ADAPTER_CYCLE_THREADS_GROWTH {max(counts) - baseline} over {_ADAPTER_CYCLES} cycles")
        print(f"ADAPTER_CYCLE_ACCEPTED {accepted['n']} of {_ADAPTER_DIALS}")
        print(f"ADAPTER_CYCLE_PARKED {parked} of {_ADAPTER_DIALS}")
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001 - teardown must not mask the rows
            pass
        for c in subs:
            try:
                c.close()
            except OSError:
                pass
        try:
            srv.close()
        except OSError:
            pass
    return rows


def _guarded(check) -> bool:
    try:
        return check()
    except (KeyboardInterrupt, SystemExit):
        raise
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
    except (KeyboardInterrupt, SystemExit):
        raise
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
