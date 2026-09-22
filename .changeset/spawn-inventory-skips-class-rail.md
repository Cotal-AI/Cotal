---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A manager whose boot inventory has no available connector no longer takes unpinned `spawn` or `launch` on the class `one` rail. Those commands stay on scatter and on this instance's `inst` rail, so a sibling that can launch them can win the queue, and a caller that pins this instance still gets a named harness refusal. `describe` still lists the commands. Manager `status` reports `classSpawn` for that skip (cluster revision 15). A partial inventory keeps the class rail; a harness refusal there names `--on`, because the standing serve credential cannot read sibling inventories.
