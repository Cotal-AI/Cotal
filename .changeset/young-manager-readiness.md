---
"cotal-ai": patch
---

Daemon setup rechecks a temporarily unobserved Manager before refusing an application PATH refresh.

Readiness reobservation has a 15-second bound. Refusals retain their actual cause, give a retry step and record the cause in the daemon journal without bypassing the idle-seat fence.
