---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

Add `credential()` to `ServiceEndpointRenewal`: the same single-flight pull as `bearer()`, answering the whole validated `credential` result (the witness, the host-authorized snapshot and the access bearer) a guest hands to `authorizeGuestServeGrant`. `bearer()` now delegates to that one pull, so concurrent `bearer()` and `credential()` calls share one request under the same persisted activate and renew ids, and an ended or closed source refuses both the same way with nothing sent. The stock source in `@cotal-ai/auth` implements it; no extra request or renewal loop is added.
