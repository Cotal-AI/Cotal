"""Drive the REAL Cotal adapter's ``commands`` request (plugin/cotal/commands.py) and report the list
it answers.

Invoked by `operator-commands.smoke.ts`. The upstream `gateway`, `hermes_cli` and `agent` packages
are not installed in CI, so the probe stubs the names the plugin imports from them: a small command
registry with Hermes's availability rule, one plugin command, two skill commands and the slash
access policy. The adapter and the list it builds are the connector's own code. The probe prints the
answers and the TypeScript side grades them.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import types
from dataclasses import dataclass

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
        pass


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


@dataclass
class CommandDef:
    name: str
    description: str
    args_hint: str = ""
    cli_only: bool = False
    gateway_config_gate: str | None = None


_commands = types.ModuleType("hermes_cli.commands")
_commands.COMMAND_REGISTRY = [
    CommandDef("status", "Show session info"),
    CommandDef("model", "Switch model", "[model]"),
    CommandDef("paste", "Paste from the clipboard", cli_only=True),
    CommandDef("verbose", "Toggle tool progress", cli_only=True, gateway_config_gate="display.verbose"),
    CommandDef("quiet", "Hide tool progress", cli_only=True, gateway_config_gate="display.quiet"),
]
# Hermes's rule: a command not marked CLI-only, or a CLI-only one whose config gate is on.
_commands._is_gateway_available = lambda cmd, gates: not cmd.cli_only or (cmd.gateway_config_gate is not None and cmd.name in gates)
_commands._resolve_config_gates = lambda: {"verbose"}
_commands._iter_plugin_command_entries = lambda: [("deploy", "Deploy the site", "<env>")]
# The gateway checks slash access only for a command its registry knows.
_commands.is_gateway_known_command = lambda name: name in {c.name for c in _commands.COMMAND_REGISTRY}

_skills = types.ModuleType("agent.skill_commands")
_skills.get_skill_commands = lambda: {"/release-notes": {"description": "Write release notes"}, "/blank": {}}

POLICY = {"enabled": False}
SEEN = []
_access = types.ModuleType("gateway.slash_access")


class Policy:
    def __init__(self, enabled):
        self.enabled = enabled

    def can_run(self, user_id, name):
        return user_id == "operator" and name in {"status", "help"}


def policy_for_source(config, source):
    SEEN.append({"config": config, "user": source.user_id, "chat": source.chat_id})
    return Policy(POLICY["enabled"])


_access.policy_for_source = policy_for_source

sys.modules.update(
    {
        "gateway": types.ModuleType("gateway"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": _base,
        "gateway.config": _cfg,
        "gateway.session": _session,
        "gateway.slash_access": _access,
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.commands": _commands,
        "agent": types.ModuleType("agent"),
        "agent.skill_commands": _skills,
    }
)

# The adapter's constructor builds the bridge client singleton, which reads this path and does not
# dial it. The request under test never touches the socket.
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-operator-commands.sock")
os.environ.setdefault("COTAL_CONTROL_KEY", "operator-commands-probe-token")
os.environ.setdefault("COTAL_CONTROL_VERSION", "1")
sys.path.insert(0, PLUGIN_PARENT)

from cotal.adapter import CotalAdapter  # noqa: E402

adapter = CotalAdapter(PlatformConfig())
out = {}
try:
    asyncio.run(adapter._commands())
    out["no_runner"] = None
except RuntimeError as e:
    out["no_runner"] = str(e)
adapter.gateway_runner = types.SimpleNamespace(config="the-gateway-config")
out["open"] = asyncio.run(adapter._commands())["commands"]
POLICY["enabled"] = True
out["gated"] = asyncio.run(adapter._commands())["commands"]
out["seen"] = SEEN
print("RESULT " + json.dumps(out))
