"""Drive the REAL Cotal adapter's ``send_clarify`` and turn end, and the clarify module's answer
handling (plugin/cotal/clarify.py), and report the frames they send and what they resolve.

Invoked by `clarify.smoke.ts`. The upstream ``gateway`` and ``tools`` packages are not installed in
CI, so the probe stubs the names the plugin imports from them: the base adapter's own
``send_clarify``, which records a text prompt, and ``tools.clarify_gateway``, whose resolve records
what it was handed. The adapter and the clarify module are the connector's own.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
import types

PLUGIN_PARENT = sys.argv[1]

# ---- stub ONLY the upstream imports --------------------------------------------------------
BASE: list = []
_base = types.ModuleType("gateway.platforms.base")


class SendResult:
    def __init__(self, success=False, message_id=None, error=None, **kw):
        self.success, self.message_id, self.error = success, message_id, error


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        pass

    async def send_clarify(self, chat_id, question, choices, clarify_id, session_key, metadata=None):
        BASE.append([chat_id, clarify_id])
        return SendResult(success=True)


_base.BasePlatformAdapter = BasePlatformAdapter
_base.MessageEvent = lambda **kw: types.SimpleNamespace(**kw)
_base.MessageType = types.SimpleNamespace(TEXT="text", PHOTO="photo")
_base.SendResult = SendResult
_base.cache_image_from_bytes = lambda data, ext=".jpg": ""
_session = types.ModuleType("gateway.session")
_session.build_session_key = lambda source, **kw: ""
_cfg = types.ModuleType("gateway.config")
_cfg.Platform = lambda name: types.SimpleNamespace(name=name)
_cfg.PlatformConfig = type("PlatformConfig", (), {})

RESOLVED: list = []
WAITING: set = set()
_clarify = types.ModuleType("tools.clarify_gateway")
_clarify._lock = threading.RLock()
_clarify._entries = {}
_clarify.get_clarify_timeout = lambda: 120


def _resolve(clarify_id, response):
    RESOLVED.append([clarify_id, response])
    return clarify_id in WAITING


_clarify.resolve_gateway_clarify = _resolve
_tools = types.ModuleType("tools")
_tools.clarify_gateway = _clarify

sys.modules.update({
    "gateway": types.ModuleType("gateway"),
    "gateway.platforms": types.ModuleType("gateway.platforms"),
    "gateway.platforms.base": _base,
    "gateway.config": _cfg,
    "gateway.session": _session,
    "tools": _tools,
    "tools.clarify_gateway": _clarify,
})

_dir = tempfile.mkdtemp(prefix="cotal-clarify-probe-")
_material = os.path.join(_dir, "material.json")
with open(os.open(_material, os.O_WRONLY | os.O_CREAT, 0o600), "w", encoding="utf-8") as fh:
    json.dump({"controlKey": "clarify-probe-control-key", "controlVersion": 1}, fh)
os.environ["COTAL_LAUNCH_MATERIAL"] = _material
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-clarify-probe.sock")
os.environ.pop("COTAL_HERMES_EVENTS", None)
sys.path.insert(0, PLUGIN_PARENT)

from cotal import clarify, hooks  # noqa: E402
from cotal.adapter import CotalAdapter  # noqa: E402

CONNECTED = {"v": True}


class Client:
    """The bridge client: records the frames the plugin sends."""

    def __init__(self):
        self.frames = []

    def clarify(self, frame):
        if not CONNECTED["v"]:
            return False
        self.frames.append(frame)
        return True

    def clarify_end(self, clarify_id, resolved):
        self.frames.append({"t": "clarify_end", "id": clarify_id, "resolved": resolved})

    def delta_end(self, key):
        pass

    def busy(self, count):
        pass


client = Client()
adapter = CotalAdapter(_cfg.PlatformConfig())
adapter._client = client
hooks.journal_wake = lambda: None


def send(chat, clarify_id, choices, session="s-op"):
    frames, base = len(client.frames), len(BASE)
    result = asyncio.run(adapter.send_clarify(
        chat_id=chat, question="Which color?", choices=choices, clarify_id=clarify_id, session_key=session, metadata=None))
    return {"success": result.success, "error": result.error, "frames": client.frames[frames:], "base": BASE[base:]}


def answer(frame):
    frames, resolved = len(client.frames), len(RESOLVED)
    clarify.answered(client, frame)
    return {"frames": client.frames[frames:], "resolved": RESOLVED[resolved:]}


def turn_done(chat):
    frames = len(client.frames)
    event = types.SimpleNamespace(source=types.SimpleNamespace(chat_id=chat))
    asyncio.run(adapter.on_processing_complete(event, "success"))
    return {"frames": client.frames[frames:]}


out = {}
out["operator"] = send("operator", "c1", ["red", "blue"])
_clarify._entries["cm"] = types.SimpleNamespace(multi_select=True)
out["multi"] = send("operator", "cm", ["staging", "prod"])
out["peer"] = send("dm:peer", "cp", ["red", "blue"], session="s-peer")
CONNECTED["v"] = False
out["offline"] = send("operator", "co", ["red"])
CONNECTED["v"] = True

WAITING.add("c1")
out["answered"] = answer({"t": "clarify_answer", "id": "c1", "response": "blue"})
send("operator", "c2", ["red"])
out["late"] = answer({"t": "clarify_answer", "id": "c2", "response": "red"})
out["unknown"] = answer({"t": "clarify_answer", "id": "nope", "response": "red"})

send("operator", "c3", ["red"])
out["peerTurnDone"] = turn_done("dm:peer")
out["turnDone"] = turn_done("operator")
WAITING.add("c3")
out["afterTurn"] = answer({"t": "clarify_answer", "id": "c3", "response": "red"})

print("RESULT " + json.dumps(out))
os.remove(_material)
os.rmdir(_dir)
