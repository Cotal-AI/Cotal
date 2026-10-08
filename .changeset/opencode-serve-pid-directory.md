---
"@cotal-ai/connector-opencode": patch
---

An OpenCode agent launch no longer fails with `EISDIR` when an empty directory sits at the agent's `serve.pid`. The launcher now treats that directory as no record, removes it, and starts the server, and a directory that vanishes before that removal also counts as no record. A directory that holds files is refused with `ENOTEMPTY` and left in place, and an unreadable record still fails the launch.
