---
"@cotal-ai/core": patch
---

`resolveService` no longer starts contract-store reads after it has failed. When one closure walk failed, the resolve rejected at once, but the walks queued behind the first window kept starting and each issued its own store reads for a call nobody could use. A failed walk now stops the pool from starting more; walks already in flight finish on their own.
