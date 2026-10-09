---
"@cotal-ai/connector-opencode": patch
---

On macOS and Linux, the process that becomes an OpenCode agent's `opencode serve` now writes its own pid to the agent's `serve.pid` before the server starts. Before, the launcher wrote the record only after the server had started, so a launcher killed in between left a server holding the agent's database with no record, and the next launch of that name started a second server on the same database. Windows still records the server from the launcher after the start.
