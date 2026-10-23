---
"@cotal-ai/cli": patch
---

`cotal up` refuses a URL or port-bearing `--host`, or one naming another address than `--server`,
before anything is written. On a prepared root the controller stack used to take such a value, exit
3, and leave a stack journal and trust behind, so every later `up` refused with `LIFECYCLE_BLOCKED`.
