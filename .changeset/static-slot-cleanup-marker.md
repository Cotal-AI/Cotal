---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Record a durable cleanup-complete marker on a terminalizing static managed slot before the final CAS to `retired`. A `terminalizing` row was previously consistent with three worlds (cleanup not started, cleanup in flight, or cleanup completed with the process dead before the CAS) that the state could not tell apart, so a resumed terminal always re-ran `cleanup()` as the only total option and the row could never assert cleanup was already done. `runStaticTerminal` now runs the footprint cleanup through one at-most-once helper that writes `cleanupComplete: true` on the `terminalizing` slot before the `retired` CAS; a resumed terminal reads it and skips a completed cleanup. The marker distinguishes the cleanup-completed world from the not-known-complete worlds (which keep the same remedy: re-run the idempotent cleanup) and adds no unrecoverable intermediate state.
