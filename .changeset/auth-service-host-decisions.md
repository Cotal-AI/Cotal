---
"@cotal-ai/auth": patch
---

Move the service host's decisions (the shared proposal closes, decide and revoke) out of `service-host-ops.ts` into an internal `service-host-decisions.ts`. The package surface is unchanged.
