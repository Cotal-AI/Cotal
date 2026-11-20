---
"@cotal-ai/auth": patch
---

Move the `AuthAuthorityPlane` interface out of `service.ts` into an internal `service-plane-types.ts`. `service.ts` re-exports the type, so the package surface is unchanged.
