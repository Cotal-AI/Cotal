---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-jcode": patch
---

A whitespace-only `model` or `variant` is now refused everywhere a launch selector enters: a persona file's `model:`/`variant:` when it loads or is saved, `cotal spawn --model`, a manifest agent's `model`/`variant`, and every launch the manager admits, including a direct `Manager.startAgent` call. Before, the same blank value was dropped by the manager, rendered into the harness command and environment by the `claude`, `codex` and `opencode` connectors, and refused only by `jcode`, so one persona launched differently depending on who started it. The manager no longer coerces a blank model to absent, and the `jcode` connector no longer carries its own blank-variant check.
