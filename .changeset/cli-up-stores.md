---
"@cotal-ai/cli": patch
---

Move the up command's stream and memory-bucket setup out of `up.ts` into an internal `up-stores.ts`. The module surface of `up.ts` is unchanged.
