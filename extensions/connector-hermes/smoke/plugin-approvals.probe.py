"""Drive the REAL Cotal adapter's ``send_exec_approval`` and the approval hooks (plugin/cotal/
approvals.py) and report the frames they send and the resolutions they make.

Invoked by `plugin-approvals.smoke.ts`. The upstream ``gateway`` and ``tools`` packages are not
installed in CI, so the probe stubs the names the plugin imports from them: the platform base,
``resolve_gateway_approval`` in the shape of each Hermes release, and the approval timeout. The
adapter, the hooks and the approvals module are the connector's own code. The probe prints what
happened and the TypeScript side grades it.
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
_base = types.ModuleType("gateway.platforms.base")


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        pass

    def build_source(self, **kw):
        return types.SimpleNamespace(**kw)


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

RESOLVED = []


def resolve_with_reason(session_key, choice, resolve_all=False, reason=None):
    RESOLVED.append({"session": session_key, "choice": choice, "reason": reason})
    return 1


def resolve_without_reason(session_key, choice, resolve_all=False):
    RESOLVED.append({"session": session_key, "choice": choice})
    return 1


_approval = types.ModuleType("tools.approval")
_approval.resolve_gateway_approval = resolve_with_reason
_approval._get_approval_timeout = lambda: 60
_approval_context = types.ModuleType("tools.approval_context")
_approval_context._get_approval_timeout = lambda: 300

sys.modules.update({
    "gateway": types.ModuleType("gateway"),
    "gateway.platforms": types.ModuleType("gateway.platforms"),
    "gateway.platforms.base": _base,
    "gateway.config": _cfg,
    "gateway.session": _session,
    "tools": types.ModuleType("tools"),
    "tools.approval": _approval,
})

# A managed launch's material, asking. The adapter's client reads its control key from it and never
# dials: every frame goes to the stand-in client below.
_dir = tempfile.mkdtemp(prefix="cotal-approvals-probe-")
_material = os.path.join(_dir, "material.json")
with open(os.open(_material, os.O_WRONLY | os.O_CREAT, 0o600), "w", encoding="utf-8") as fh:
    json.dump({"controlKey": "approvals-probe-control-key", "controlVersion": 1, "askPermissions": True}, fh)
os.environ["COTAL_LAUNCH_MATERIAL"] = _material
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-approvals-probe.sock")
sys.path.insert(0, PLUGIN_PARENT)

from cotal import approvals, hooks  # noqa: E402
from cotal.adapter import CotalAdapter  # noqa: E402


class Client:
    """The bridge client: records the frames the plugin sends."""

    def __init__(self):
        self.frames, self.up = [], True

    def approval(self, frame):
        if self.up:
            self.frames.append(frame)
        return self.up

    def approval_end(self, session_key, outcome):
        self.frames.append({"t": "approval_end", "session": session_key, "outcome": outcome})


client = Client()
adapter = CotalAdapter(_cfg.PlatformConfig())
adapter._client = client
hooks.get_client = lambda: client


def in_tool_thread(tool, call_id, session):
    """``pre_tool_call`` then ``pre_approval_request`` on one worker thread, as Hermes runs a tool."""
    def run():
        if tool:
            hooks.pre_tool_call(tool_name=tool, args={"command": "x"}, tool_call_id=call_id)
        hooks.pre_approval_request(session_key=session, command="x", description="d")
    t = threading.Thread(target=run)
    t.start()
    t.join()


def ask(session, tool=None, call_id="", **flags):
    in_tool_thread(tool, call_id, session)
    before = len(client.frames)
    result = asyncio.run(adapter.send_exec_approval(
        chat_id="operator", command="rm -rf build", session_key=session, description="recursive delete", metadata=None, **flags))
    frames = client.frames[before:]
    return {"success": result.success, "error": result.error, "frame": frames[0] if frames else None}


out = {}
approvals._asks = False
out["off_buttons"] = CotalAdapter.supports_exec_approval_buttons()
out["off"] = ask("sk-off", "terminal", "call-0")
out["off_noted"] = dict(approvals._tools)

approvals._asks = None
out["on_buttons"] = CotalAdapter.supports_exec_approval_buttons()
out["full"] = ask("sk1", "execute_code", "call-7")
out["no_permanent"] = ask("sk2", allow_permanent=False)
out["no_session"] = ask("sk3", allow_session=False)
out["smart_denied"] = ask("sk4", smart_denied=True)

full_id = out["full"]["frame"]["id"]
approvals.answered({"id": full_id, "choice": "session"})
approvals.answered({"id": out["no_permanent"]["frame"]["id"], "choice": "deny", "reason": "Not the build folder."})
approvals.answered({"id": "unknown", "choice": "once"})
approvals.answered({"id": full_id, "choice": "yolo"})
out["resolved"] = list(RESOLVED)

before = len(client.frames)
hooks.post_approval_response(session_key="sk1", choice="session")
hooks.post_approval_response(session_key="sk1", choice="session")
hooks.post_approval_response(session_key="sk-never", choice="timeout")
out["ends"] = client.frames[before:]

client.up = False
RESOLVED.clear()
out["down"] = ask("sk5")
out["down_resolved"] = list(RESOLVED)
before = len(client.frames)
hooks.post_approval_response(session_key="sk5", choice="deny")
out["down_ends"] = client.frames[before:]
client.up = True

_approval.resolve_gateway_approval = resolve_without_reason
RESOLVED.clear()
out["old"] = ask("sk6")
approvals.answered({"id": out["old"]["frame"]["id"], "choice": "deny", "reason": "no"})
out["old_resolved"] = list(RESOLVED)

sys.modules["tools.approval_context"] = _approval_context
out["new_timeout"] = ask("sk7")["frame"]["timeoutMs"]

print("RESULT " + json.dumps(out))
os.remove(_material)
os.rmdir(_dir)
