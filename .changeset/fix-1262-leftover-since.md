---
"@cotal-ai/manager": patch
---

A leftover turn acceptance whose deadline commit never remembered is aged off `leftoverSince` (when the pending latch dropped), not off the original deadline.

Aging off `deadlineAt` would prune a long-outage leftover on the first sweep tick and take the GoalRef a late yield still needs. `commitTurnDeadline` stamps that clock when it deletes pending.
