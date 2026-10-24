---
"@cotal-ai/cli": patch
---

A background service's log no longer grows without bound across runs. A start or restart moves a
log of 16 MiB or more to `<log>.1`, replacing an earlier one, and the run writes a fresh log. A
running service's log grows until its next start.
