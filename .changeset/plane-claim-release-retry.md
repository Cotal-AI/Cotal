---
"@cotal-ai/auth": patch
---

Plane-claim release no longer caches a rejected KV operation. A hosted `close()` that cannot reach the claim row still rejects, but it can be retried after the broker reconnects without reopening the scanners. The exported `planeClaimRefusal()` reports `release-unreachable` for this retryable refusal and `lost` when another claim owns the row; a release also accepts its own already-released row after an uncertain write acknowledgment.
