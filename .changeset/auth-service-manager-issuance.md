---
"@cotal-ai/auth": patch
---

Move the authority plane's manager-service issuance, platform-supervisor end, endpoint deregistration and remote Manager maintenance operations out of `service.ts` into an internal `service-manager-issuance.ts`. `service.ts` re-exports `authorizeRemoteManagerRetirement`, so the package surface is unchanged.
