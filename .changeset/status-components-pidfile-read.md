---
"@cotal-ai/cli": patch
---

`cotal status --components` no longer aborts every row when one component's PID record cannot be read. The pass checked that a pidfile existed and then read it, so a component that removed its own record between those two calls, or a record the pass could not read, threw out of the whole pass: it printed the header with no rows and exited 1, the same code as `absent`. The record is now read once. A record that is gone reads as `absent`, and any other read error makes that component `refused`, naming the error, while the other rows print as before. Bare `cotal status` now reads each local process record and the manager's delivery-aware marker once as well, so a process that exits while status runs no longer aborts the command.
