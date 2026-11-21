---
"@cotal-ai/cli": patch
---

Move the down command's state-preserving stop and pidfile liveness reads out of `down.ts` into an internal `down-preserve.ts`. `down.ts` re-exports every name it exported before, so the module surface is unchanged.
