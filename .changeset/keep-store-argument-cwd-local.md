---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Keep paths out of telemetry when a file blocks the config folder or a command refuses an unexpanded `--store-dir`. The CLI still names the affected folder. For a blocked config folder it now asks for an unused name instead of printing a move command that splits paths at spaces and can replace an existing file.
