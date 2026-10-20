---
"@cotal-ai/core": patch
---

Let agents read channel history through their existing lifecycle-scoped, single-filter consumer grant. Static and user-auth agents can read allowed channels without gaining unfiltered consumer creation. Reads share the lifecycle history lock with backfill and recall, and cancellation releases the reader before returning.
