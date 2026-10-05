---
"@cotal-ai/manager": patch
---

Stop a superseded manager from serving. If a manager stalled long enough for a second process of the same instance to take its liveness lease and register at a newer epoch, the first process logged that another pid held its key and kept serving. On an open mesh nothing evicted it, so both processes answered the instance's rail. A manager whose lease is held by another process now logs that the other process serves the instance, and exits. It does not deregister on the way out, because the registration is the successor's now. A lease that cannot be renewed or read, or that expired and can be put back, still never ends the process.
