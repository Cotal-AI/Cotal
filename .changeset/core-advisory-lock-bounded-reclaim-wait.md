---
"@cotal-ai/core": patch
---

Bound a blocking advisory lock acquisition by its wait limit while a stale lock is being reclaimed. `acquireLock` kept polling a live reclaimer without checking the deadline, so a zero-wait or short-wait caller blocked until the reclaim finished, and never returned when the reclaimer was its own process. It now applies one wait limit to a live owner and a live reclaimer, as `acquireLockAsync` already does, and fails with the caller's contention error once the limit passes.
