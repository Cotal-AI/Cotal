---
"@cotal-ai/manager": patch
---

A clean `Manager.stop()` now waits for a renew already in flight and releases the liveness lease key at the broker's own revision instead of a cached one, so a same-root restart no longer waits out the bucket TTL when a renew was racing the stop.
