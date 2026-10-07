---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A static slot row whose latest KV operation is a DEL or PURGE marker is now refused as corruption by the manager's startup reconcile sweep and by the `slots` listing behind `cotal ps --slots`, the way `inspect` and a new spawn of that name already refused it. Both enumerations used to drop a marked row: the sweep reported nothing to reconcile for it and the listing omitted it. They now read through one slot walk built on the new core `walkKvLatest`, which returns the latest entry of every matching key with its markers.
