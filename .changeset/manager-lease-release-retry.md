---
"@cotal-ai/manager": patch
---

A clean `Manager.stop()` no longer leaves its liveness lease to expire when a read of the lease key times out, as one can while the connection reconnects. The stop asks again for up to one lease TTL, so the key is released once the broker answers and a same-root restart of the same instance starts at once instead of being refused until the key lapses.
