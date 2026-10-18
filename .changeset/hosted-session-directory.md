---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Claude Code sessions report the directory their own `SessionStart` hook supplies on startup, resume or fork, not the connector process directory, so sessions hosted in one process no longer all show the host's directory. The directory is absent until the hook reports it and is not changed by clear or compact. `CotalEndpoint.setCardCwd` and `MeshAgent.setCwd` set it, and `MeshAgent`'s new `withholdProcessCwd` option leaves it unset at construction.
