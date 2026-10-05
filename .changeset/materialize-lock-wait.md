---
"@cotal-ai/workspace": patch
---

Loading an installed extension now waits up to five seconds for another `cotal` process that is installing, removing or updating extensions, instead of failing at once with "extension install/remove is in progress". Before, a command that started a moment before the other process finished its work was refused, though a retry would have succeeded. If the other process is still running after the wait, the load fails with the same message as before.
