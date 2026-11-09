---
"@cotal-ai/delivery": patch
"@cotal-ai/cli": patch
---

A space created before live eviction gets its missing connection evictor the next time the delivery daemon starts, so a despawned seat's name is released without rotating the system account. The daemon mints it only on a root that hosts one space and retained its system-account signing seed, beside an observer that same system account signed; anywhere else, a root hosting several spaces included, the heal does nothing and the daemon starts as before. An evictor that is already present is left untouched.
