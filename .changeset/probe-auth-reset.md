---
"@cotal-ai/core": patch
---

A broker probe now reports `auth-required` when the broker's greeting asked for auth and the connection was then reset during the handshake. On Windows that reset can discard the broker's authorization error, so `cotal who` against a running auth broker with credentials it rejects said the mesh was not up and suggested unregistering it.
