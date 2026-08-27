---
"@cotal-ai/connector-core": patch
---

`cotal_spawn` now accepts an optional kickoff `prompt` and forwards it through the manager as the new peer's first turn.

A peer spawned through the MCP tool previously had no way to receive an initial prompt even though the manager's `spawn` command already supported one. The process joined the roster, and a later DM produced a successful `claude/channel` notification, but a pristine Claude session did not start its first model turn from that notification. The peer therefore stayed idle and never answered. Callers can now pass the task with the spawn itself, matching `cotal spawn --prompt` while keeping prompt-less launches idle by choice.
