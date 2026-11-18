---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Connector repair and self-update can continue after a direct npm child is interrupted on POSIX.
The child's close releases its mutation marker while Windows intermediary failures remain guarded.
A refused update recovery snapshot also discards its unpublished target generation.
