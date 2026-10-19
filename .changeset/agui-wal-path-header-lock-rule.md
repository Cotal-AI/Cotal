---
"@cotal-ai/connector-core": patch
---

The `agui-wal-path` module header now states the principal lock's rule: `.lock` is held by one emitter per principal, `acquirePrincipalLock` is the exclusion, and the generation guard in `EventWal.write` refuses a stale handle's write. It no longer recounts the lock's earlier computed-only revision or the review that found it. No behavior changes.
