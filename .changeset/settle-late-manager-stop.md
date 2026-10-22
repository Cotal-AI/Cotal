---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A manager stop that completes after `cotal down` stopped waiting no longer blocks the stack. The next bare `up` or `down` reads the stop's own receipts, records the manager `stopped` when it recorded the stop completed and its process is gone, releases the stop reservation, and continues. A stop with no completed receipt still refuses `LIFECYCLE_BLOCKED`.
