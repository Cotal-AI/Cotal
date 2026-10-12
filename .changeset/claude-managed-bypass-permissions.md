---
"@cotal-ai/connector-claude-code": minor
---

Managed Claude seats now launch with `--permission-mode bypassPermissions` by default. A spawned seat has no human at its terminal, so under the default mode its first `cotal_dm` stopped at a permission prompt nobody could answer and the seat looked dead to its peers. An operator who wants prompts back passes `--opt permission-mode=default` (or any other mode); the connector adds the default only when the launch options carry neither `permission-mode` nor `dangerously-skip-permissions`.
