---
"@cotal-ai/manager": patch
---

Keep connector executable paths pinned across availability rechecks and flaps instead of switching to another copy on `PATH`, recheck connector binaries in batch `resume-preserved` launches and supervised crash restarts, include `--on` guidance on instance-pinned wire launch refusals, and skip `syncClassSpawn` when the serve connection is already closed.
