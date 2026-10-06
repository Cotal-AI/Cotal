---
"@cotal-ai/connector-opencode": minor
---

The OpenCode launcher keeps the server password off command lines and stdout. The 1.x TUI reads it from its environment instead of `attach --password`, and the headless `[cotal-serve]` line now carries only `port` and `session`. A headless host that drives the server passes its own `OPENCODE_SERVER_PASSWORD` to the launcher; without one, the launcher mints a password per launch as before.
