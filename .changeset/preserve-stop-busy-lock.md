---
"@cotal-ai/cli": patch
---

A preserve-state stop that cannot acquire the maintenance lock now reports a blocked operation and how to retry, rather than an unknown outcome. It does not stop the running stack.
