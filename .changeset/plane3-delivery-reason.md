---
"@cotal-ai/core": patch
---

A channel message delivered through the Plane-3 backstop now reports why the trusted reader delivered it. `MessageMeta.deliveryReason` is `durable-channel` for a durable member's copy and `live-mention` for an `@mention` on a live channel, read from a new `Cotal-Delivery-Reason` header the reader writes beside the unchanged version-1 frame. Payload mentions and text never set it. An older recipient ignores the header and still receives the copy; a copy from an older reader is delivered with no reason, and one with an unrecognized reason is delivered with none and reported as a warning.
