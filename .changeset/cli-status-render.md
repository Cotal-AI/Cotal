---
"@cotal-ai/cli": patch
---

Move the status command's report rendering out of `status.ts` into an internal `status-render.ts`. `status.ts` re-exports every name it exported before, so the module surface is unchanged.
