---
"@cotal-ai/manager": patch
---

Refuse a reap that could not read its custody record, instead of reporting it as a reaped seat.

`absent` says the record was unreadable, which is a fact about addressability rather than liveness. A custodian that dies after spawning its child and before writing the record leaves a live seat and no record, and so does a stale reference. Both of the manager's rendering sites turned that into "already forgotten" and carried on, so a successor could free an alias while the seat was still running. The refusal now lives in `requireRuntimeReap`, so `absent` cannot reach a caller at all.
