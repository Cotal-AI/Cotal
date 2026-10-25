---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Accept `cotal up -d` as the short form of `--detach`, consistent with managed agent spawning.
Startup still runs in the background by default, and combining `-d` with `--foreground` refuses
before anything starts.
