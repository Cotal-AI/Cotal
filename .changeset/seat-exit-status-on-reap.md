---
"@cotal-ai/seat": patch
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The seat custodian now sends the child's exit code and signal with its exit event, and the seat handle reports them through `exitInfo()`. A Linux pty seat whose process exits on its own is logged as `seat reaped: ... exit code <n>[, signal <s>]` instead of `exit detail unavailable from runtime "pty"`. The line also names the last line the child printed that starts with a connector's `[cotal-<name>]` or `[cotal-<name>/<part>]` prefix, cut to 240 characters, such as `[cotal-jcode] AG-UI emitter stopped: ...` or `[cotal-hermes/bridge] ...`. The custodian writes the same record beside the custody record, so a reap of the seat by reference reports how the child ended. When that record cannot be written, the custodian logs why, and the reap of a child that ended on its own says the record is missing or unreadable.
