---
"@cotal-ai/manager": patch
---

A supervised seat that a successor manager restarts after a crash now stays supervised when it joins after its readiness window. The seat record counts the restart as soon as the replacement launches, so a later successor no longer grants one restart past the budget. When the seat joins, its restart is armed as for one that joined in time, so its next crash restarts it in place instead of retiring it. The late join is matched only against heartbeats newer than the dead seat's.
