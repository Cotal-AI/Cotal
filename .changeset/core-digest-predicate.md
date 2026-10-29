---
"@cotal-ai/core": patch
---

Guard `isContractDigest` with `typeof s === "string"` (`s is string`) and route the digest-scalar checks in `endpoint-cluster.ts`, `endpoint-service.ts`, `endpoint-journal.ts`, `remote-manager-authority.ts`, and `endpoint-receipt.ts` through that shared predicate instead of private regex copies or unchecked string casts.
