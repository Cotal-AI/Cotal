---
"@cotal-ai/manager": patch
---

A same-lifecycle restart or a resume now fails when the manager cannot record the new seat's custody reference on its static slot. It used to log the failure, or return silently when the slot was not this lifecycle's active row, and start or keep the seat anyway, so the slot still named the previous seat. A successor manager then reaped that seat, found it already gone, and retired the lifecycle and freed the name while the new seat kept running outside every manager. A restart that cannot record the reference now retires the seat, and a resume fails and stops any seat it started.
