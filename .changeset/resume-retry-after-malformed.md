---
"@cotal-ai/cli": patch
---

Treat a Retry-After value that is neither whole seconds nor an HTTP date as absent, so a throttled conversation resume no longer prints "Wait at least 0 seconds".
