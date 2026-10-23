---
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
---

`CotalEndpoint.releaseDeliveryLease` and `releaseManagerLease` now reject when their delete does not commit. A release at a revision the row has moved past rejects with the broker's refusal, and a broker failure rejects with its own error. Both used to resolve as if the lease were released, so a caller could not tell a release from a refused or failed one. `releaseDeliveryLease` with an `undefined` revision still releases nothing, and `releaseManagerLease` without a revision still deletes the key unconditionally. The delivery daemon and the manager still finish their shutdown when a release fails. A hosted delivery `close()` whose release is refused now rejects with the broker's reason.
