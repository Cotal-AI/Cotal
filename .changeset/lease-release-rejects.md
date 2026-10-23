---
"@cotal-ai/core": minor
"@cotal-ai/delivery": patch
---

`CotalEndpoint.releaseDeliveryLease` and `releaseManagerLease` now reject when their delete does not commit. A refused compare-and-swap, because the row moved on, rejects as a CAS loss (`isCasLoss`), and a broker failure or timeout rejects too. They used to resolve in every case, so a caller could not tell a released lease from one still held. `releaseDeliveryLease` with an `undefined` revision still releases nothing. A caller that wants best effort at shutdown catches the rejection, as the delivery daemon and the manager do. A hosted delivery `close()` now takes the release's outcome from the release itself rather than reading the row back.
