---
"@cotal-ai/cli": patch
---

`down --preserve-state` on a legacy root now refuses, before it stops anything, while a saved
service in the space still runs or cannot be verified, and names each one with the
`cotal service stop` that stops it. It used to stop the broker under a running service without
naming it, and a backup then proceeded with the service still running.
