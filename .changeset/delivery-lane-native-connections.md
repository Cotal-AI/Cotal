---
"@cotal-ai/delivery": patch
---

`openDeliveryLane` now returns a `DeliveryLane`, which adds `nativeConnections()` to the lane: the server id and client id of each data-account connection the lane holds, as `startDeliveryService` already reports for a hosted context. A host that runs delivery from a workstation root can compare the list with the account's native census. Existing callers are unaffected.
