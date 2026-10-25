---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Process services, and with them a prepared stack's `cotal up` and `cotal down`, run on Windows. Each
background service runs under a detached custodian that creates the program inside a job object,
which allows no breakaway and ends every member when the custodian exits. The instance records the
machine, the account's SID and the custodian's pin in place of a UID and boot ID. Commands reach the
custodian over a named pipe with a per-instance capability that both sides prove on every request. A
stop terminates the whole job, and `service status` reports `members-running` when the program
exited while its job still holds processes. A manager is woken for its native stop through its
cooperative local stop request. A foreground start, and a manager stop that would keep agents in its
job, refuse on Windows. `cotal down` refuses a member whose program exited while its job still runs,
and names the stop that ends it.
