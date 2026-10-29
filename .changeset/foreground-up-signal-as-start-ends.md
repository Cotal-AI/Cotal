---
"@cotal-ai/cli": patch
---

A Ctrl-C or `SIGTERM` that reached a foreground controller `cotal up` as its start ended, such as one sent on seeing the start receipt, was dropped: the stack kept running and the terminal kept holding it until a second signal. That signal now runs the guarded whole-stack stop and exits 130 or 143, as a signal at any other moment does.
