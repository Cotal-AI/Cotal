---
"@cotal-ai/cli": patch
---

Move the up command's detached broker start, listener supervision, root claims and mesh recording out of `up.ts` into an internal `up-detach.ts`. `up.ts` re-exports every name it exported before, so the module surface is unchanged.
