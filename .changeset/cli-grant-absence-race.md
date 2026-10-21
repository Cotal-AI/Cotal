---
"@cotal-ai/auth": patch
---

Refuse an interactive grant that found no row when another grant for the same actor lands while it waits for the ledger lock, instead of overwriting it.
