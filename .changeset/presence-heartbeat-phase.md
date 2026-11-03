---
"@cotal-ai/core": patch
---

Keep each endpoint's presence heartbeat on its own phase. Repeating timers that Node re-arms in one pass stay bunched after a loop stall, so one process holding many endpoints put every heartbeat into the same tick. The heartbeat now re-arms from its own start instant, so stalls no longer bunch heartbeats and the interval and TTL are unchanged.
