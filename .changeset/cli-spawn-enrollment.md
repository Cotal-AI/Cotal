---
"@cotal-ai/cli": patch
---

Move the spawn command's enrollment and managed-handoff helpers out of `spawn.ts` into an internal `spawn-enrollment.ts`. `spawn.ts` re-exports every name it exported before, so the module surface is unchanged.
