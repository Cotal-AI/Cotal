---
"@cotal-ai/core": patch
---

Emit recoverable endpoint retry notices on `warning` instead of `error`, so a consumer with no error listener is not killed by a condition the endpoint is already surviving.
