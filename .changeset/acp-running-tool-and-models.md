---
"@cotal-ai/acp": patch
"@cotal-ai/connector-claude-code": patch
---

In ACP clients such as T3 Code, a Claude Code tool call now shows while the tool runs, and the model list no longer offers an application it cannot start.

- Claude Code: a tool call shows within about a second of its start while the tool runs.
- `cotal acp`: lists an application's default model once when its catalog also has a model named `default`.
- `cotal acp`: refuses an application whose models the manager could not read, with the manager's reason, in place of offering its default alone.
