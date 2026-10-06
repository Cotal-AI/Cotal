---
"@cotal-ai/auth": patch
---

An auth-service context started by the CLI composition no longer carries a made-up hosted context. The shared builder gave every handle a `readiness()` and, with no assigned context, reported the store's data account with an empty lifecycle UID, a key no assignment names and `startAuthService` itself refuses. Only `startAuthService` now attaches `readiness()`, and it reports the context it was assigned.
