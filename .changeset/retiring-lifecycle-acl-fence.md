---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A retired agent no longer keeps a durable membership row written after its inventory. The fence that stopped those writes lived in one delivery daemon's memory, so a join whose ACL lookup outlived it, a join from a still-connected seat after a daemon restart, or a join a quiesced daemon finished after its successor took over could still leave a row. The manager now narrows the retiring lifecycle's read-ACL row to no reads before it asks for the inventory (`fenceLifecycleAcl`). The daemon re-reads that exact row just before and just after a join writes its membership row, and when the channel is no longer allowed it writes nothing, or removes the row it wrote, and refuses the join. A leave's tombstone only updates a row that still exists, so it can no longer recreate a purged one. The daemon's own in-memory fence stays beside it, so a manager that does not narrow the row is still fenced on the daemon that served its inventory.
