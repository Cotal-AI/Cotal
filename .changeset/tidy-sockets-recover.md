---
"@cotal-ai/connector-core": patch
---

Recover a Unix control socket left by a crashed connector when the host restarts its MCP server with the same launch environment. Probe before retrying so a live listener still refuses the replacement.
