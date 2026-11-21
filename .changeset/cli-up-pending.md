---
"@cotal-ai/cli": patch
---

Move the up command's pending restore and resume registries out of `up.ts` into an internal `up-pending.ts`. The module surface of `up.ts` is unchanged.
