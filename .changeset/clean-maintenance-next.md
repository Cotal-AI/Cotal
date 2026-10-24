---
"@cotal-ai/cli": patch
---

`clean store` and `clean all` on a root that holds maintenance state now name the step that moves
it on. After a plain `down --preserve-state` they refused with exit 1, no Next and "use the recorded
restore recovery or fallback-cleanup command", but `backup recover` and `backup cleanup-fallback`
take no `preserve-` id. They now refuse `LIFECYCLE_BLOCKED` (exit 2), name the attempt and its
state, and give as Next the step `cotal status` shows for that attempt, such as resuming a
preserved cut with bare `cotal up`, followed by stopping the mesh and running the clean again.
