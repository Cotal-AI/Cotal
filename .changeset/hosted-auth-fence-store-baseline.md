---
"@cotal-ai/auth": patch
---

The hosted auth fence smoke takes its injected-store baseline after each plane's first start, which now puts the plane's instance identity into the store, so its store cells check that the fence and close write nothing on top of that record.
