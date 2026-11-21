---
"@cotal-ai/cli": patch
---

Move the update command's npm and process runners and version parsing out of `update.ts` into an internal `update-process.ts`. `update.ts` re-exports every name it exported before, so the module surface is unchanged.
