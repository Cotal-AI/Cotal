---
"@cotal-ai/delivery": patch
---

The delivery daemon's `close()` wakes the timer writer's retry backoff instead of waiting it out. A close that landed while the writer was sleeping between attempts used to wait for the rest of that backoff, up to five minutes, before the daemon finished stopping.
