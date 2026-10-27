---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A manager stop that retires many seats at once no longer leaves their membership rows behind. The delivery daemon answers the `lifecycleMemberships` inventory without holding it behind its other admin commands, so a retirement's inventory no longer waits behind every other seat's eviction and misses its 5 s deadline. Inventories that arrive together share one read of the members bucket, and each read begins after its request arrived, so every answer stays complete and lifecycle-exact. A read that fails refuses every request that waited on it. The manager now runs at most 8 retirements at a time, so a stop no longer opens dozens of broker connections together and trips the broker's 2 s authentication timeout, which had also left rows behind. A seat's inventory is still requested only after its own eviction has returned.
