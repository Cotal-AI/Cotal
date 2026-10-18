---
"@cotal-ai/workspace": patch
---

Recording or removing a mesh now throws the read error when the registry directory exists but cannot be listed for the pre-hex record sweep. Before, the sweep read every listing failure as an absent registry, so a removal could return while a pre-hex record of the same space stayed behind and listed the mesh again. An absent registry directory still has nothing to sweep.
