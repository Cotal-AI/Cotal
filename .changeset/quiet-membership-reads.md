---
"@cotal-ai/core": patch
---

Durable delivery and the membership feed stop rereading every membership row on each post or connection event. The delivery writer looks up the channel and its covering families in a view checked against the broker's current revision. The feed still reconciles subscriptions on connection events and on its safety poll.
