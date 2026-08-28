---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Preserve the first Claude event run when a startup prompt is written before `SessionStart`, while resumed, forked, cleared, compacted, and recovered sessions keep their no-history-replay cursor behavior.
