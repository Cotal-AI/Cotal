---
"@cotal-ai/orca": patch
---

The Orca runtime's read-only CLI calls (`status`, `worktree current`/`show`, `terminal list`/`show`/`read`) now give up after 2 seconds. They run synchronously on the manager's event loop, so an Orca app that was up but not answering blocked the whole manager, every seat's supervision included, for as long as it stalled: the manager's 5-second `status()` poll, the handle lookup before `stop`, `interrupt` and `attach`, the availability check and worktree resolution all waited on it with no limit. A status check that times out still reports the agent as running.
