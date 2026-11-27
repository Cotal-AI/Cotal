"""The slash commands a Hermes seat's owner can run through the agent endpoint: the ones the gateway's
own ``/commands`` lists, as the operator chat may run them. Each runs in the operator chat as
``/<name> <args>`` (src/commands.ts).

The registry, its availability rule, the plugin and skill commands and the slash access policy are
Hermes's own, all present across the supported 0.18 to 0.21 range.
"""
from __future__ import annotations

from typing import Any


def operator_commands(gateway_config: Any, source: Any) -> list[dict]:
    """Each gateway and plugin command the gateway lists that its slash access lets ``source`` run,
    and each skill command. Access is checked as the gateway checks it when the command runs: for a
    command it knows, and only once an operator has turned slash access on."""
    from agent.skill_commands import get_skill_commands
    from gateway.slash_access import policy_for_source
    from hermes_cli.commands import (
        COMMAND_REGISTRY,
        _is_gateway_available,
        _iter_plugin_command_entries,
        _resolve_config_gates,
        is_gateway_known_command,
    )

    policy = policy_for_source(gateway_config, source)
    gates = _resolve_config_gates()
    listed = [(c.name, c.description, c.args_hint) for c in COMMAND_REGISTRY if _is_gateway_available(c, gates)]
    listed += _iter_plugin_command_entries()
    entries = [
        {"name": name, "target": "command", "description": description, "inputHint": hint}
        for name, description, hint in listed
        if not (policy.enabled and is_gateway_known_command(name) and not policy.can_run(source.user_id, name))
    ]
    for slash, info in sorted(get_skill_commands().items()):
        entries.append({"name": slash.lstrip("/"), "target": "skill", "description": str(info.get("description") or "")})
    return entries
