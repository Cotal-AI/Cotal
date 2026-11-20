---
"@cotal-ai/auth": patch
---

Move the auth service's process and context host (`runAuthService`, `startAuthService` and its handle, the lane and multi-tenant host runners, and `startAuthContext`) out of `service.ts` into an internal `service-host.ts`. The package surface is unchanged.
