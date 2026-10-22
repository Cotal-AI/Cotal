---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

Add `AuthProvider.serviceEndpointRenewal`, a renewal source for one registered service witness that a long-lived service endpoint passes as its bearer function. The first pull activates and later pulls renew, replaying one persisted request per operation, so renewal never exhausts the instance's request bound. An outage is reported as `unavailable` and retried with the same request; a revocation, expiry or other denial ends the source. Tokens leave only through `bearer()`.
