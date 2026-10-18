---
"@cotal-ai/core": patch
"@cotal-ai/seat": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

Every managed user-mode lifecycle a manager provisions now records durable slot custody under `mgrslot.<holderOwner>.<targetOwner>-<actor>` (plus its holder index `mgrslot.<holderOwner>._index`) in `KV_cotal_records_<space>` and reaches terminal retirement when its seat is proved gone. `remoteManagerPermissions` grants the supervisor credential only subject-confined publish and `DIRECT.GET` access on `mgrslot.<holderOwner>.*` (never a records-stream consumer). `enrollUserAgent` records `phase: "enrolling"` with `tokenHash` and `enrollSpec` before calling `enrollManagedAgent` so a lost enrollment reply or crash converges on `tokenHash` and retires the unlaunched lifecycle on startup. `inspectProcessStart`, `identityVerdict`, `reapSeat`, `drainSeats`, and `probeRecordedProcess` use a three-valued fail-closed contract (`"live" | "gone" | "unknown"`) so an unreadable `/proc/<pid>/stat` (`EACCES`) keeps custody rather than claiming exit. Startup reconciliation preserves live released custodial seats, defers and adopts resumed inventories across `resumePreserved` -> `finalizeResume`, and leaves cross-owner delegated launches (`SPEC §13.16`) held until a user retirement intent confirms retirement.
