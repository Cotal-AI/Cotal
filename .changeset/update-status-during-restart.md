---
"cotal-ai": patch
---

Updating a computer that hosts a Manager no longer fails while the daemon restarts. `cotal daemon status` keeps answering while a hosted Manager starts or stops, and the update waits through that restart.
