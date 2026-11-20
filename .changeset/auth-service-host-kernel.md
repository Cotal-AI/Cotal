---
"@cotal-ai/auth": patch
---

Move the service host's S2-A record kernel (record keys and ids, keyed reads and writes, capacity release, operation settlement and debt, and the result arms) out of `service-host-ops.ts` into an internal `service-host-kernel.ts`. The package surface is unchanged.
