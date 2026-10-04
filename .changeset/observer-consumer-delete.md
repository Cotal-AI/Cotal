---
"@cotal-ai/core": patch
---

Drop the stream-wide `CONSUMER.DELETE` grants from the observer, admin and agent profiles. An observer could delete another principal's live presence, channel-registry and membership watches and the delivery daemon's `fanout` durable, and an agent could delete a peer's presence and registry watches; those deletes are now refused by the broker. A client's refused delete of its own ephemeral watch or history consumer is treated as handled, and the broker removes that consumer five minutes after its last interest.
