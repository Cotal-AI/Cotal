---
"@cotal-ai/workspace": minor
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

`createManagerInstanceIdentity` and `createAuthInstanceIdentity` now take a `mint` callback (`() => ManagerInstanceIdentity` and `() => AuthInstanceIdentity`) instead of an already-minted identity, matching `claimIdentityRecord`. The manager and auth service call them directly without a preceding `loadManagerInstanceIdentity` or `loadAuthInstanceIdentity` check.
