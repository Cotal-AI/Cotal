---
"@cotal-ai/workspace": patch
---

Loading an installed extension now waits up to five seconds in total for another `cotal` process that is installing, removing or updating extensions, instead of failing at once. Before, a command that started a moment before the other process finished its work was refused, though a retry would have succeeded. The wait does not block the process: timers, requests and cancellation keep running while the load is queued. If the other process is still running when the five seconds are up, the load fails with "another extension update or mutation is in progress (pid ...) - retry once it finishes" when the update pass is held, or with "extension install/remove is in progress (pid ...) - retry after the active `cotal ext` command finishes" when only the install/remove lock is held.
