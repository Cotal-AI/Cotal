---
"@cotal-ai/connector-core": patch
---

The `agui-wal-path` module header, which ships in `dist/agui-wal-path.js`, now labels `.lock` as held by one emitter per principal and states why `acquirePrincipalLock` and the `EventWal.write` generation guard both exist, without recounting the earlier computed-only `lockPath` revision or a reviewer reproduction. No behavior changes.
