---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
---

Retain custody records on disk across seat exit until verified reaping confirms kernel process identities and purges the directory, enabling manager process restart reconciliation. Ensure reapSeat verifies descendant process group departure even when the leader process has already exited.
