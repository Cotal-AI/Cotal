---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Keep Claude lifecycle hooks inside their existing bounded relay window when the connector control socket has not bound yet, so an early `SessionStart` is not lost while later hooks continue normally.
