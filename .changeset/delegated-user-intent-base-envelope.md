---
"@cotal-ai/core": patch
---

`parseRemoteManagerEnvelope` and `parseDelegatedUserIntentRequest` now share one core-internal parser for the base request fields (`v`, `kind`, `space`, `actor`, `instanceId`, `requestId`), so a change to a shared base rule reaches both parsers. In `parseRemoteManagerEnvelope`, the base fields are now checked before `managerLifecycleUid`.
