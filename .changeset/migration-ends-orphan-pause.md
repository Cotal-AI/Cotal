---
"@cotal-ai/runtime": minor
---

A migration commit ends pending orphan pauses before recording the migration.

`MigrateOrphan` now includes its journal state, and callers supplying a `commitMigration` handler must provide `endPause` beside `discharge`. Pass the run's `MeshHandler` and journal entries so removed pending steps can release their timers and wait consumers. Missing cleanup custody or a failed cleanup refuses the commit before it records success. Settled orphans are not ended again.
