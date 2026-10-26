---
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
"@cotal-ai/connector-core": minor
---

One manager can host seats on different terminal runtimes at the same time.

`cotal spawn --runtime <name>` with `-d` or `--on`, `cotal_spawn` with `runtime`, and a workflow `spawn(persona, { runtime })`, choose the runtime of that one seat. A seat that names none keeps the runtime the manager was started with. An unknown or unreachable runtime, and `auto`, refuses the launch and starts nothing. Stopping, attaching, and recovery follow the runtime recorded for that seat, so a later seat does not move one that is already running.
