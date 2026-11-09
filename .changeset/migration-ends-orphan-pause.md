---
"@cotal-ai/runtime": patch
---

A migration commit now ends the pause of a step the edited program no longer reaches, when that step is still pending.

The orphan row for a removed `sleep`, `wait`, `ask`, `checkpoint`, `turn` or `waitUntil` says nothing outlives it. `commitMigration` now claims that pause through the run handler's `endPause` before the migration record is filed, the same way a `--release` tears its seat down before the record says it did. A step that already settled ended its own pause, and a commit that would ignore a pending one of these but has no journal and no handler is refused before anything is written.
