---
"@cotal-ai/manager": patch
---

The manager schedules its `endpoint-serve` credential renewal from the credential's own window instead of a quarter-TTL tick whose phase is set at boot, pushes the renewed credential to the live serve, goal-writer and session-ledger connections with a reconnect, and treats a closed serve connection as a fault: it re-dials with the current credential, re-mints an expired one, and after a bounded retry releases its lease and exits loud instead of holding the lease deaf (#2073).
