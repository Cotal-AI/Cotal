"""Drive the REAL Cotal adapter's draft methods, ``post_api_request`` and the turn journal
(plugin/cotal/streams.py, journal.py) and report the frames and records they produce.

Invoked by `stream.smoke.ts`. The upstream ``gateway`` package is not installed in CI, so the probe
stubs the names the plugin imports from it, the session context included, whose chat id the test
sets per call. The adapter, the hooks, the stream tracker and the journal are the connector's own.
The probe prints what happened and the TypeScript side grades it.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import types

PLUGIN_PARENT = sys.argv[1]
JOURNAL = sys.argv[2]

# ---- stub ONLY the upstream imports --------------------------------------------------------
_base = types.ModuleType("gateway.platforms.base")


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        pass


class SendResult:
    def __init__(self, success=False, message_id=None, error=None, **kw):
        self.success, self.message_id, self.error = success, message_id, error


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
CHAT = {"id": ""}
_context = types.ModuleType("gateway.session_context")
_context.get_session_env = lambda name, default="": CHAT["id"] if name == "HERMES_SESSION_CHAT_ID" else default

sys.modules.update({
    "gateway": types.ModuleType("gateway"),
    "gateway.platforms": types.ModuleType("gateway.platforms"),
    "gateway.platforms.base": _base,
    "gateway.config": _cfg,
    "gateway.session": _session,
})

_dir = tempfile.mkdtemp(prefix="cotal-streams-probe-")
_material = os.path.join(_dir, "material.json")
with open(os.open(_material, os.O_WRONLY | os.O_CREAT, 0o600), "w", encoding="utf-8") as fh:
    json.dump({"controlKey": "streams-probe-control-key", "controlVersion": 1}, fh)
os.environ["COTAL_LAUNCH_MATERIAL"] = _material
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-streams-probe.sock")
os.environ["COTAL_HERMES_EVENTS"] = JOURNAL
sys.path.insert(0, PLUGIN_PARENT)

from cotal import hooks  # noqa: E402
from cotal.adapter import CotalAdapter  # noqa: E402


class Client:
    """The bridge client: records the frames the plugin sends."""

    def __init__(self):
        self.frames = []

    def delta(self, key, text):
        self.frames.append({"t": "delta", "key": key, "text": text})

    def delta_end(self, key):
        self.frames.append({"t": "delta_end", "key": key})

    def busy(self, count):
        pass


client = Client()
adapter = CotalAdapter(_cfg.PlatformConfig())
adapter._client = client
hooks.journal_wake = lambda: None


def guarded(fn):
    """A step's result, or the error it raised, so the TypeScript side grades each cell."""
    def run(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}", "frames": []}
    return run


@guarded
def draft(chat, draft_id, content):
    before = len(client.frames)
    result = asyncio.run(adapter.send_draft(chat_id=chat, draft_id=draft_id, content=content))
    return {"success": result.success, "frames": client.frames[before:]}


@guarded
def respond(chat, content, platform="cotal"):
    """``post_api_request`` for a response in ``chat``, with the stub context naming the chat."""
    CHAT["id"] = chat
    hooks.post_api_request(platform=platform, assistant_message={"content": content, "tool_calls": []})


@guarded
def done(chat):
    before = len(client.frames)
    event = types.SimpleNamespace(source=types.SimpleNamespace(chat_id=chat))
    asyncio.run(adapter.on_processing_complete(event, "success"))
    return client.frames[before:]


out = {}
# A response before any draft reads no session context: the stub is not even installed yet.
out["first"] = respond("operator", "before any stream")
sys.modules["gateway.session_context"] = _context
out["buttons"] = guarded(lambda: adapter.supports_draft_streaming(chat_id="operator", chat_type="dm", metadata=None))()
out["limit"] = guarded(lambda: adapter.streaming_overflow_limit())()

out["d1"] = draft("operator", 7, "Hel")
out["d2"] = draft("operator", 7, "Hello wor")
out["same"] = draft("operator", 7, "Hello wor")
out["other_chat"] = draft("dm:peer", 7, "Elsewhere")
respond("dm:peer", "Elsewhere, saved.", platform="telegram")
respond("operator", "Hello world.")
out["late"] = draft("operator", 7, "Hello world")

out["n1"] = draft("operator", 9, "First stretch")
out["n2"] = draft("operator", 10, "Second")
out["broken1"] = draft("operator", 10, "Sec")
out["broken2"] = draft("operator", 10, "Second, longer")
respond("operator", "Second, longer and saved.")

out["ws1"] = draft("operator", 13, "\n\nOutput:")
out["ws2"] = draft("operator", 13, "\n\nOutput: ok \n")
out["ws3"] = draft("operator", 13, "\n\nOutput: ok \nDone")
respond("operator", "Output: ok \nDone.")

out["cut"] = draft("operator", 14, "Interrupted rep")
out["done"] = done("operator")
out["after_done"] = draft("operator", 14, "Interrupted reply")
out["peer_done"] = done("dm:peer")

del os.environ["COTAL_HERMES_EVENTS"]
out["unarmed"] = draft("operator", 15, "Not streamed")

print("RESULT " + json.dumps(out))
os.remove(_material)
os.rmdir(_dir)
