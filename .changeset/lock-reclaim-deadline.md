---
"@cotal-ai/core": patch
---

`acquireLock` now honors its `waitMs` while another live process is reclaiming a stale lock, as `acquireLockAsync` already did. Before, the synchronous acquirer retried the reclaim with no deadline check. A zero-wait acquisition then blocked its event loop until the reclaimer finished, and never returned when the reclaimer was its own process.
