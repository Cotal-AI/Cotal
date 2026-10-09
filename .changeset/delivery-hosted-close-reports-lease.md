---
"@cotal-ai/delivery": patch
---

The `startDeliveryService` handle's `close()` and `drain()` now reject when the instance did not give its shard lease back: the lease row is still held after the close, by another holder or because the release did not commit, or the broker could not confirm the release. They used to resolve in every case, so a host that started a successor at once could be refused with "a live lease already exists" without any prior signal. The rest of the teardown still runs, and the bucket TTL still expires a row the instance left. A failed start keeps its own error and logs a release that also failed.
