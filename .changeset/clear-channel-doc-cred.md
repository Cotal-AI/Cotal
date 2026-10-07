---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

The `clearChannel` doc comment now tells callers to pass a `channel-purger` cred. It named a `manager` cred, a profile that `mintCreds` no longer accepts. The comments on `seedChannelRegistry`, the `purger` profile and `cotal channels` now name the creds those paths use. No behavior changes.
