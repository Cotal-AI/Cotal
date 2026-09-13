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


def _race_live_reader_kept() -> bool:
    """The other half: a genuinely running reader must SURVIVE reopen.

    Dropping the reference to a live thread would let `start()` create a second reader on the same
    socket, which is a different bug in the same method. This is the near-neighbour control for the
    assertion above: the two differ only in whether the reader actually exits.
    """
    client = BridgeClient(_sockpath)
    release = threading.Event()
    reader = threading.Thread(target=lambda: release.wait(5), daemon=True)
    client._reader = reader
    client._stop.set()
    reader.start()
    try:
        client.reopen()
        return client._reader is reader and not client._stop.is_set()
    finally:
        release.set()
        reader.join(timeout=5)


main()
