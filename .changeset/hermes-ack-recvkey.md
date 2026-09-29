---
"@cotal-ai/connector-hermes": patch
---

The Hermes Python client now acks a surfaced delivery under `recvKey`, the field the bridge matches, so each delivery is retired and the bridge no longer stops after the first automatic item of a gateway boot.
