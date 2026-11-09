---
"@cotal-ai/delivery": patch
"@cotal-ai/cli": patch
---

A space created before live eviction gets its missing connection evictor the next time the delivery daemon starts, so a despawned seat's name is released without rotating the system account. The daemon only mints it on a root that hosts one space and retained its system-account signing seed, and it leaves an evictor that is already present untouched.
