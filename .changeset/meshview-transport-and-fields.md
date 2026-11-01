---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`MeshView` now reports disconnected while the broker is down. It used to follow only the endpoint's `connection` event, which stays true while the NATS client reconnects on its own, so `cotal console` showed a green dot and `cotal watch` read "live" through the outage. It now also follows the endpoint's `transport` edge, and `cotal watch` reads "Reconnecting" during an outage. Feed entries also carry the wire's `replyTo`, `mentions` and `contextId` when the sender set them, so `cotal watch --json` rows include those fields. A unicast burst coalesces only when those fields match.
