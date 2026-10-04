---
"cotal-ai": patch
---

A failed `smoke:manager-stop-reap` run now prints the state of the delivery daemon it started: whether it exited, with its exit code and signal, or is still running, read again after the rail request so a daemon that dies during it is not reported as running, what one fresh request on its `ctl.delivery-admin` rail returns, and the tail of its output. A rail timeout alone read the same for a dead, a stalled and a slow daemon, so every red run had to be investigated from scratch.
