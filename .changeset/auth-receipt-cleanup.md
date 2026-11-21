---
"@cotal-ai/auth": patch
---

Auth cleanup skips already validated service receipts on each periodic sweep. Hosted auth services can set the cleanup interval with `nativeIssuancePruneMs`.
