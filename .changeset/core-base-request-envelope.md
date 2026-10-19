---
"@cotal-ai/core": patch
---

`parseDelegatedUserIntentRequest` and `parseRemoteManagerEnvelope` now check the base request envelope (`v`, `kind`, `space`, `actor`, `instanceId` and the `requestId` idempotency token) with one shared parser instead of two hand-copied sets of rules, so a change to one of those rules reaches both requests. Refusal texts are unchanged. A registered-manager request with several faults may now name a base-field fault before a `managerLifecycleUid` fault.
