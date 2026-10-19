---
"@cotal-ai/workspace": minor
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

`createManagerInstanceIdentity` and `createAuthInstanceIdentity` now take a `mint` function in place of an identity, and call it only when the root holds no record, as `claimIdentityRecord` does. Before, every caller had to mint a lifecycle uid and a serve nkey that a stored record then discarded, so the manager and the auth plane each loaded the record first and called the wrapper only when it was absent. A first start therefore read the absent record twice before creating it. Both now make one call, which reads the record once. Code that passes an identity to either function passes `() => identity` instead.
