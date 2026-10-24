---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A turn's goal-index entry now records the seat's owner in its acceptance floor beside the seat's name, actor and uid, as a spawn's entry does, and the relay note no longer carries it. A restarted manager reads the whole seat from the floor. A turn an older manager accepted has no owner in its floor, so a restarted manager leaves it unadopted and logs it, and its run's turn ends at its deadline.
