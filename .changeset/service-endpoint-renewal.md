---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

Add `AuthProvider.serviceEndpointRenewal`, a renewal source for one registered service witness that a long-lived service endpoint passes as its bearer function. The first pull activates and later pulls renew, replaying one persisted request per operation, so renewal never exhausts the instance's request bound. An outage, a missing sign-in or a store failure is reported as `unavailable` and retried with the same request, and an expired renewal proof reactivates on the signed-in login under the same request; a revocation, expiry of the root or approval, or other denial from the space ends the source. Tokens leave only through `bearer()`.
