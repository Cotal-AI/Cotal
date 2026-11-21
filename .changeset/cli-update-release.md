---
"@cotal-ai/cli": patch
---

Move the update command's release and dependency availability checks out of `update.ts` into an internal `update-release.ts`. `update.ts` keeps every name it exported before, so the module surface is unchanged.
