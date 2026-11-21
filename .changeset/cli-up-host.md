---
"@cotal-ai/cli": patch
---

Move the up command's bind-host checks out of `up.ts` into an internal `up-host.ts`. The module surface of `up.ts` is unchanged.
