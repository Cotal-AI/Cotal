---
"@cotal-ai/auth": patch
---

Move the service host's caller policy (caller grants, caller revocation and the policy reads) out of `service-host-ops.ts` into an internal `service-host-caller.ts`. The package surface is unchanged.
