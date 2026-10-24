---
"@cotal-ai/cli": patch
---

The `chat --stdio` docs now define `join`'s `backfilled`: the retained channel messages the join read back, which can be more than the inbox gains when some were already handed over, held or dropped.
