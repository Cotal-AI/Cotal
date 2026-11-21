---
"@cotal-ai/cli": patch
---

Move the update command's running-manager continuity checks out of `update.ts` into an internal `update-continuity.ts`. `update.ts` re-exports every name it exported before, so the module surface is unchanged.
