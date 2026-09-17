---
---

The bearer refresh suite now grades the refresh-margin edge on a pinned clock: a re-served token with zero margin left is refused, the same token with one millisecond left is adopted, a re-served token with most of its life left is adopted, and a refusal arms the retry at 15 seconds. The boundary flip, a threshold moved above zero, the deleted margin conjunct, and a ten-minute retry delay each survived the previous suite and now fail a named cell.

Refs #1561
