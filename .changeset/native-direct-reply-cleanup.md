---
"@cotal-ai/core": patch
---

Release each completed batched KV read's native reply subscription immediately through the native callback API, instead of retaining it until its five-second timeout. Paging, empty reads, tombstones and permission refusals remain unchanged.
