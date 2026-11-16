---
"@cotal-ai/manager": patch
---

An attached terminal now reports that the agent exited when the agent's own process ends, instead of reporting that it was stopped.

The manager ended every live attach session with `target-despawn` when it freed a seat, and its exit watcher runs before the session sees the process exit, so a natural exit reached the caller as a stop. A seat that exits on its own, including the last exit of a spent restart budget, now ends its sessions with `process-exit`. A stop, a reap and a failed restart still end them with `target-despawn`.
