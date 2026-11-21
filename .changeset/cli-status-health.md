---
"@cotal-ai/cli": patch
---

Move the status command's component health pass out of `status.ts` into an internal `status-health.ts`. `status.ts` re-exports every name it exported before, so the module surface is unchanged.
