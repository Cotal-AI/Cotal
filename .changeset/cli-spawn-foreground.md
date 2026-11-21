---
"@cotal-ai/cli": patch
---

Move the spawn command's foreground provisioning helpers out of `spawn.ts` into an internal `spawn-foreground.ts`. `spawn.ts` re-exports `runBearerPreflight`, so the module surface is unchanged.
