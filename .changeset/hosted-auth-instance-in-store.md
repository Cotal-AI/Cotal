---
"@cotal-ai/auth": patch
"@cotal-ai/workspace": patch
---

A hosted auth context started through `startAuthService` now keeps the auth plane's instance identity, whose serve seed is a private nkey, in its injected `SecretStore` under the new `authInstanceKey(space)`, with the other auth secret kinds. It used to write that record under `stateDir`, which the hosted contract documents as non-secret state. The first start of an upgraded context puts the earlier record into the store, removes the file and keeps the instance. A store and `stateDir` that hold different identities refuse the start. `@cotal-ai/workspace` exports `removeAuthInstanceIdentity`. A CLI root keeps its record where it was.
