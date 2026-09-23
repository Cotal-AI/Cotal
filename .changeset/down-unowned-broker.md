---
"@cotal-ai/cli": patch
---

Bare `cotal down` names a registered broker that answers when this stack holds no pidfile for it. It prints the space, the broker address, that no pidfile records the process, and that it will not stop a process it did not start, then exits 1. It no longer says nothing is running in that case.
