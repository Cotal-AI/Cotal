---
"@cotal-ai/connector-core": patch
---

Move the `cotal_spawn`, `cotal_feedback`, `cotal_despawn`, `cotal_yield`, `cotal_run`, `cotal_persona` and `cotal_personas` tool specs out of `tool-specs.ts` into `tool-specs-manager.ts`, in the same order and with the same capability filtering. The package index exports `shownSpawnName` and `spawnResult` as before. The package surface is unchanged.
