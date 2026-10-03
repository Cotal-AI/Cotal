---
"@cotal-ai/seat": patch
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A pty seat whose process exits on its own is logged as `seat reaped: ... exit code <n>[, signal <s>]` followed by the last line the child printed that starts with a connector's `[cotal-<name>]` or `[cotal-<name>/<part>]` prefix, cut to 240 characters, such as `[cotal-jcode] AG-UI emitter stopped: ...` or `[cotal-hermes/bridge] ...`. This holds for a seat the manager spawned in-process and for one a seat custodian holds. The custodian now sends the child's exit code, signal and that diagnostic with its exit event, and the seat handle reports them through `exitInfo()`, so a custodial seat no longer reads `exit detail unavailable from runtime "pty"`. `@cotal-ai/seat` exports the shared `ConnectorDiagnosticReader`. The custodian writes the same record beside the custody record, so a reap of the seat by reference reports how the child ended. When that record cannot be written, the custodian logs why, and the reap of a child that ended on its own says the record is missing or unreadable.
