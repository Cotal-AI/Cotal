---
---

Smoke shards now read a cell-count sentinel from each suite's own output. A suite that exits 0 with no sentinel, or with zero cells run, fails the shard by name instead of counting as a covered pass, and the shard banner reports cells graded, not only suites.
