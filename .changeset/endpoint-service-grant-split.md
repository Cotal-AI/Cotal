---
"@cotal-ai/core": patch
---

Split serve-credential authorization and the issuance fence out of `endpoint-service.ts` into an internal module that it re-exports. The package's exports are unchanged.
