---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A foreground `cotal up` that refuses because another terminal holds the stack keeps `--max-sessions` in the restart command it prints, so following that command starts the manager at the ceiling you asked for.
