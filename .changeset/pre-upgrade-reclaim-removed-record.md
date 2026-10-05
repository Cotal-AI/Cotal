---
"@cotal-ai/workspace": patch
---

A manager or delivery start on an upgraded root no longer aborts with `ENOENT` when the pre-upgrade `manager.pid`, `manager.delivery-aware` or `delivery.pid` record it is reclaiming is removed after it was listed and before it was read, which happens when the pre-upgrade daemon exits or a concurrent start reclaims the same record. `reclaimDeadPreUpgradeRecord` still finds the record by its byte-exact name, then reads it once through `readPidfile` and moves on to the next spelling when it is gone. Every other read error still propagates, and the empty, unattributable, live and unknown-liveness rules are unchanged.
