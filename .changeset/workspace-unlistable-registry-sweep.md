---
"@cotal-ai/workspace": patch
---

The pre-hex record sweep that runs when a mesh is recorded or removed now throws any error listing the registry directory other than ENOENT. Before, the sweep read every listing failure as an absent registry, so a removal could return while a pre-hex record of the same space stayed behind and listed the mesh again. An absent registry directory still has nothing to sweep.
