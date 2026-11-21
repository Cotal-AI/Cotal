---
"@cotal-ai/connector-opencode": patch
---

An OpenCode agent no longer offers `/reconnect` to remote callers. The agent endpoint's `commands` list leaves out the `/reconnect` the connector's launch injects, and a `command` that names it ends `refused` with `failed-precondition` instead of running and dropping the link its answer needs. `/reconnect` still works at the agent's terminal.
