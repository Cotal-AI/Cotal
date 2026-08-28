---
"@cotal-ai/connector-claude-code": patch
---

Preserve Claude event startup when `UserPromptSubmit` or a turn terminal reaches the connector before the separate `SessionStart` hook process supplies its source context.
