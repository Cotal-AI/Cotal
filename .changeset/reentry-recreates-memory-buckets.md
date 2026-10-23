---
"@cotal-ai/cli": patch
---

A re-entry `up` that adopts the surviving listener of an interrupted restore or resume now
recreates the space's memory-only buckets before the daemons start. When the first `up` stopped
after binding its listener and before it made them, the delivery daemon exited with "stream not
found" and the re-entry reported a degraded control plane.
