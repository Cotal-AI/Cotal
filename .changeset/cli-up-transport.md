---
"@cotal-ai/cli": patch
---

Move the up command's broker transport, TLS and store-selection checks out of `up.ts` into an internal `up-transport.ts`. The module surface of `up.ts` is unchanged.
