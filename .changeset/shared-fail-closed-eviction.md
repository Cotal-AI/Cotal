---
"@cotal-ai/auth": patch
---

Both barrier evictors build their unverified eviction result, and the note they use when the delivery-admin rail cannot be reached, through one helper each. A change to that result or that note can no longer land in only one evictor. What either evictor returns and logs is unchanged.
