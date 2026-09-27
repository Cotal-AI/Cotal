---
"@cotal-ai/core": patch
---

Plane-3 durable fan-out and membership-transfer publishes omit `Nats-Msg-Id` for an `id: ""` message instead of deriving one from the empty id, so two distinct id-less posts on a durable channel both reach a member instead of the second being collapsed by the broker's duplicate window (#673). A message with a real id keeps its idempotent publish key unchanged.
