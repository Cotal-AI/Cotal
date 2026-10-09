---
"@cotal-ai/cli": patch
---

`cotal up` now waits for a manager it starts to come up before it reports it. A refresh used to print `✓ restored in the background: manager (pid N)` and exit 0 the moment it had spawned the process, so a manager that refused at boot and exited seconds later, for example while a crashed predecessor's lease had not expired, read as restored. A manager that exits before it comes up, or whose pidfile another `cotal supervise` takes over first, is now reported as a degraded control plane naming its log, and a refresh exits nonzero.
