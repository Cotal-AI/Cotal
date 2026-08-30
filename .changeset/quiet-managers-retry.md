---
"@cotal-ai/core": patch
---

Retry the read-only endpoint describe bootstrap within its original deadline so a responder that registers just after the first request is still discovered.
