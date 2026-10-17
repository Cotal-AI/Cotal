---
"@cotal-ai/core": patch
---

A timer writer's `stop()` no longer waits out the 5 second poll window when it lands while the pump is still issuing a fetch or between two batches. The pump closes that fetch as soon as it is issued, so the delivery daemon no longer spends that window stopping a writer it has just started.
