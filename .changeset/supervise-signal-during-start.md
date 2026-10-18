---
"@cotal-ai/manager": patch
---

`cotal supervise` now handles `SIGTERM` and `SIGINT` from the moment it starts. Before, its handlers were installed only after the manager finished starting, so a signal during startup killed the process with its liveness lease still held: no warning printed, and an immediate restart from the same workspace root was refused with `already serves ... stop it first` until the lease's 10 second TTL lapsed. A signal during startup now waits for the start to finish, runs the normal stop, which releases the lease, and exits 0.
