---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Count a smoke suite as gated only when a CI job actually runs it. join-external live coverage now rides its own live-job step; a duplicate connect classifier that only `pnpm check` reached is gone. Backup live suites stay UNGATED as already-red (#643 / #1285).
