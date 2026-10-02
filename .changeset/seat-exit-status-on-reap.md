---
"@cotal-ai/seat": patch
---

The seat custodian now sends the child's exit code and signal with its exit event, and the seat handle reports them through `exitInfo()`. A Linux pty seat whose process exits on its own is logged as `seat reaped: ... exit code <n>[, signal <s>]` instead of `exit detail unavailable from runtime "pty"`.
