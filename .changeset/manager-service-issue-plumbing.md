---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

`mintPublicUserJwt` in `@cotal-ai/core` now takes only what it signs with: the space and the account's public key and signing seed. The auth service passed it that partial context behind a cast that turned the type check off for every remote-manager credential it signs. It now passes the context typed. Its authority plane also opens the auth KV view once and reads every manager issuance gate through one helper, where each operation used to reopen the view and rebuild the gate inline. The activate arm's duplicate missing-gate check, which could never run, is gone.
