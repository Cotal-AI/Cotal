---
"@cotal-ai/cli": patch
---

Move the up command's manifest boot and team-boot preparation out of `up.ts` into an internal `up-manifest.ts`. `up.ts` re-exports every name it exported before, so the module surface is unchanged.
