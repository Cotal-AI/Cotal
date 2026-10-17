---
"@cotal-ai/manager": patch
---

A clean `Manager.stop()` now asks again when a read of its liveness lease times out, as one can while the connection reconnects, and stops asking once one lease TTL has passed since the release began. Before, the first timed-out read ended the release without deleting the key, so a same-root restart of the same instance was refused until the key expired. Releasing the key is still best effort: the conditional delete is sent once, and if it does not reach the broker or the stop cannot confirm the key is gone, the key stays until its TTL and a same-root restart is refused until then.
