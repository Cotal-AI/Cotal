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

    cold, warm, pushed_cold, pushed_warm = asyncio.run(scenario())
    print("PUSHED_COLD", pushed_cold)
    print("PUSHED_WARM", pushed_warm)
    print("COLD_DELIVERED", cold)
    print("WARM_DELIVERED", warm)

    if MODE == "subject":
        print("RACE_READER_CLEARED", _race_reader_cleared())
        print("RACE_LIVE_READER_KEPT", _race_live_reader_kept())


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
