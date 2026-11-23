"""Drive the REAL Cotal adapter, hooks and turn journal through operator-chat turns, and report the
journal each one leaves.

Invoked by `operator-reply.smoke.ts`. Only the upstream `gateway` package is stubbed, because it is
not installed in CI. The adapter's processing callbacks and `send`, the `pre_llm_call` and
`post_api_request` hooks, and the journal are the connector's own code, called in the order the
gateway calls them. The probe prints each scenario's journal records and the TypeScript side grades
them.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import types

PLUGIN_PARENT = sys.argv[1]

# ---- stub ONLY the upstream imports --------------------------------------------------------
_base = types.ModuleType("gateway.platforms.base")


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        pass

    def build_source(self, **kw):
        return types.SimpleNamespace(**kw)


class MessageEvent:
    def __init__(self, **kw):
        self.text = kw.get("text")
        self.source = kw.get("source")
        self.message_id = kw.get("message_id")


class MessageType:
    TEXT = "text"


class SendResult:
    def __init__(self, **kw):
        pass


_base.BasePlatformAdapter = BasePlatformAdapter
_base.MessageEvent = MessageEvent
_base.MessageType = MessageType
_base.SendResult = SendResult
_base.cache_image_from_bytes = lambda data, ext=".jpg": ""
_session = types.ModuleType("gateway.session")
_session.build_session_key = lambda source, **kw: ""

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
        "gateway.session": _session,
    }
)

journal_dir = tempfile.mkdtemp(prefix="cotal-hermes-operator-reply-")
journal_path = os.path.join(journal_dir, "journal.jsonl")
os.environ["COTAL_HERMES_EVENTS"] = journal_path
# The adapter's constructor builds the bridge client singleton, which reads this path and does not
# dial it; the probe replaces the client before any call.
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-operator-reply.sock")
os.environ.setdefault("COTAL_CONTROL_KEY", "operator-reply-probe-token")
os.environ.setdefault("COTAL_CONTROL_VERSION", "1")
sys.path.insert(0, PLUGIN_PARENT)

from cotal import hooks  # noqa: E402
from cotal.adapter import STOP_ID_PREFIX, CotalAdapter  # noqa: E402

# The journal wake relays over the control socket, which the probe has none of.
hooks.journal_wake = lambda: None


class Client:
    """The bridge client the adapter talks to: it records what the adapter routed to the mesh."""

    def __init__(self):
        self.replies = []

    def refusal(self):
        return None

    def busy(self, count):
        pass

    def reply(self, target, text, reply_to, context_id):
        self.replies.append({"target": target, "text": text})


adapter = CotalAdapter(PlatformConfig())
adapter._client = Client()
OPERATOR = adapter._operator_source()
PEER = adapter.build_source(chat_id="dm:u_peer.ada", chat_name="ada", chat_type="dm", user_id="u_peer.ada", user_name="ada")


def records():
    if not os.path.exists(journal_path):
        return []
    with open(journal_path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


async def turn(source, steps, message_id=None):
    """One message processed as the gateway does: start, the steps in order, done."""
    event = MessageEvent(text="", source=source, message_id=message_id)
    await adapter.on_processing_start(event)
    for step in steps:
        await step()
    await adapter.on_processing_complete(event, "success")


def model_call(platform, sender, content):
    async def step():
        hooks.pre_llm_call(platform=platform, sender_id=sender, session_id="s1")
        hooks.post_api_request(platform=platform, assistant_message={"content": content, "tool_calls": []})
    return step


def reply(chat_id, text, reply_to=None):
    async def step():
        await adapter.send(chat_id, text, reply_to=reply_to)
    return step


SCENARIOS = {
    "command": lambda: turn(OPERATOR, [reply("operator", "Session: 3 messages")]),
    "model": lambda: turn(OPERATOR, [model_call("cotal", "operator", "the answer"), reply("operator", "the answer")]),
    "after_model": lambda: turn(OPERATOR, [reply("operator", "Model: claude")]),
    "peer_model": lambda: turn(OPERATOR, [model_call("cotal", "u_peer.ada", "peer work"), reply("operator", "Help text")]),
    "other_platform": lambda: turn(OPERATOR, [model_call("telegram", "operator", ""), reply("operator", "Usage text")]),
    "ack_then_model": lambda: turn(OPERATOR, [reply("operator", "Retrying"), model_call("cotal", "operator", "retried"), reply("operator", "retried")]),
    "peer_chat": lambda: turn(PEER, [reply("dm:u_peer.ada", "hello ada")]),
    "stop_reply": lambda: turn(OPERATOR, [reply("operator", "Stopped.", reply_to=f"{STOP_ID_PREFIX}x")]),
    "blank": lambda: turn(OPERATOR, [reply("operator", "  \n")]),
}

out = {}
for name, run in SCENARIOS.items():
    before = len(records())
    adapter._client.replies.clear()
    asyncio.run(run())
    out[name] = {
        "records": [{k: r[k] for k in ("k", "content") if k in r} for r in records()[before:]],
        "mesh": list(adapter._client.replies),
    }
print("RESULT " + json.dumps(out))
os.remove(journal_path)
os.rmdir(journal_dir)
