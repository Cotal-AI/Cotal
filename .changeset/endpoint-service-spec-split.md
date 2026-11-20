---
"@cotal-ai/core": patch
---

Split the service registry's value shapes and validators out of `endpoint-service.ts` into an internal module that it re-exports. The package's exports are unchanged.
