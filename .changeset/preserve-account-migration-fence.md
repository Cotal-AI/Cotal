---
"@cotal-ai/core": patch
---

Waking a space keeps its migration revocations, even after a long sleep. Static credentials can have no expiry, so removing an old wildcard fence could let a revoked credential connect again.
