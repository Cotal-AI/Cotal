---
"@cotal-ai/cli": patch
---

Move the up command's broker config writers, authentication setup and credential provisioning out of `up.ts` into an internal `up-broker-auth.ts`. The module surface of `up.ts` is unchanged.
