---
"@cotal-ai/core": patch
---

The kv-scan smoke's five push-consumer stand-in cells now share one local `interposeConsumer` helper. It interposes where `liveKvEntries` binds its consumer and types the consumer from the client's `PushConsumer`, and each cell passes only its own transform. A change to that binding is now made in one place, and a cell can no longer drift from it and stop interposing while the smoke still passes. The per-cell casts of the consumer are gone. Shipped behaviour is unchanged.
