---
"@cotal-ai/cli": patch
---

A legacy project folder that was renamed or moved after `up -f` no longer leaves a stack that no `down` stops. The launch summary that `up -f` writes records its absolute folder, and after a move it named the old path, so it was counted as an unreadable record. `status` then exited 4, `team show <id>` refused `SCHEMA_INVALID`, and bare `down` refused `LIFECYCLE_BLOCKED` while the broker kept running. A summary that reads cleanly but names another folder is now listed by `status` with the folder it was recorded at, blocks no `up` or `down` in the new folder, and `team show <id>` refuses it with `CONFLICT`, naming that folder. A summary that does not parse is still reported unreadable and still blocks. A copy of a running folder still refuses `down`, so the original keeps running.
