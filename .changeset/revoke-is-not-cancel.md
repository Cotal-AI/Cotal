---
"@cotal-ai/runtime": patch
---

`cotal run revoke`, its help and the workflow docs now say that a revoke does not cancel the run:
work that touches no channel, such as a `sleep` and `log` loop, keeps running until the host driving
it stops. The docs name each way to stop that host and what else it stops.
