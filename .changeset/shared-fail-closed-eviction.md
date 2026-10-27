---
"@cotal-ai/auth": patch
---

Both barrier evictors build their unverified eviction result, and the note they use when the delivery-admin rail cannot be reached, through one helper each. A change to that result or that note can no longer land in only one evictor. The helper logs through the options it is given, on each call, so a logger that reads its options keeps them.
