---
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
---

Expose the native bindings of a hosted delivery context's data-account connections. `startDeliveryService` now returns a `DeliveryServiceHandle` whose `nativeConnections()` lists the server id and client id of the endpoint, membership-rw and timer-writer connections, so a host can compare them with the account's native census. It throws while a connection is down, redialing or adopting a credential, and reports none only after a successful close. `CotalEndpoint.nativeConnections()` and `MembershipFeedHandle.nativeDataConnections()` give the same bindings for one endpoint or one feed. No credential or connection object is returned.
