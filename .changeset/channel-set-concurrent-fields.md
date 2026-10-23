---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Concurrent `cotal channel set` writes on different fields of one channel no longer drop one of them. A channel registry write now lands on the revision it read, and a write that loses the race to another writer reads the entry again and merges again, so each confirmed field stays saved. A write that keeps losing refuses with `CONFLICT` and saves nothing, where before each writer printed `Channel saved` even when another writer overwrote its field. `channel defaults` and the runtime's channel writes use the same path.
