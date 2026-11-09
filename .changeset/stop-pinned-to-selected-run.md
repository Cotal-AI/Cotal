---
"@cotal-ai/workspace": patch
---

A stop sent through `control` can now name the run it means, so a run that replaced it under the same name is never stopped instead. `control` takes an optional `expectedTarget` (the row's `id` and `lifecycleUid`) that it passes to the manager request, which sends nothing when the name now resolves to another run. `ManagedRow` now carries the `lifecycleUid` every manager already reports, and the refusal no longer speaks only of attaching.
