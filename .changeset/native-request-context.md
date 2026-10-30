---
"@cotal-ai/core": patch
---

Avoid eager native request-origin stack capture on endpoint connections. Request failures retain their error classes and causes, with less caller-origin stack context.
