---
"@cotal-ai/auth": patch
---

Move the auth service's HTTP route handlers (chat sessions, the service endpoint host and authority routes, endpoint deregistration and the tool-result human-proof and consent routes) out of `service.ts` into an internal `service-routes.ts`. Both route tables stay in `service.ts`, which re-exports the two tool-result handlers, so the package surface is unchanged.
