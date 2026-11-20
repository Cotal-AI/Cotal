---
"@cotal-ai/cli": patch
---

Move the spawn command's managed launch path out of `spawn.ts` into an internal `spawn-managed-launch.ts`, and its flag grammar and rerun hint into an internal `spawn-flags.ts`. `spawn.ts` re-exports every name it exported before, so the module surface is unchanged.
