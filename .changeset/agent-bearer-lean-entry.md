---
"cotal-ai": patch
"@cotal-ai/auth": patch
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
---

`cotal agent-bearer` now runs before the rest of the CLI loads. A spawned seat execs it at the spawn preflight, at its first connect, at every bearer renewal and for every manager call, and loading the whole command surface made each run take about 400 ms. It now takes about 60 ms, close to the 50 ms of a bare exchange. It reads none of the CLI's preferences, extensions or config folder. A command line it cannot parse still goes to the full CLI, which refuses it with the command's help as before. The command lives in `@cotal-ai/auth/agent-bearer`, and `@cotal-ai/core/command`, `@cotal-ai/core/loopback`, `@cotal-ai/core/subjects` and `@cotal-ai/workspace/liveness` export the parser and checks it uses without loading either package root.
