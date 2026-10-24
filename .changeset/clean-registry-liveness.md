---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": patch
---

Separate liveness reporting from mismatch pruning. `pruneMesh(space)` now serves only
mismatches, without a reason argument or `PruneReason` type. `pruneStaleMeshes()` keeps
registrations and returns only `offline`, removing the always-empty `MeshSweep.pruned`
field and redundant registry reads. Callers handling an unreachable target must report
it offline without calling `pruneMesh`.
