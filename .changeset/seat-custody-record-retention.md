---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
---

Retain custody records on disk across seat exit until verified reaping confirms kernel process identities and purges the directory, enabling manager process restart reconciliation. Refuse reaping when a dead leader leaves a nonempty group whose generation cannot be proved, retaining the custody record without signalling that group.
