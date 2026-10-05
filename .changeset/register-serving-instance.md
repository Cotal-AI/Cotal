---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

Core exports `registerServingInstance`, which runs `registerServiceInstance` and then authorizes the instance's serve grant and writes its `ready` status at the `processEpoch` and `registrationRevision` that registration committed, both fenced on the registration barrier's read of the issuance gate. It returns `{ registrationRevision, processEpoch, grant }`, and an optional `status` adds fields to the ready status. The auth plane's own boot registration, the manager's boot registration and `registerRemoteManagerAuthority` now call it instead of assembling the grant and status by hand, so the epoch these steps run at comes from one place. Their behavior is unchanged.
