---
"@cotal-ai/connector-core": patch
---

The `acquirePrincipalLock` doc comment now states that the lock is held until the returned lock's `release()`, and no longer says it is held for the life of the process or recounts the module's earlier computed-only `lockPath`. No behavior changes.
