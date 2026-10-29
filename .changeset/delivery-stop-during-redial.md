---
"@cotal-ai/delivery": patch
"@cotal-ai/cli": patch
---

A delivery daemon stopped while its connection redials, as it does moments after `cotal up -d` starts the manager and the daemon moves onto a renewed credential, now waits for the redial and gives its lease back. It used to exit with the row still on the broker, so `cotal down` refused and the next `up` waited out the 30s lease. `up -d` now reports a delivery daemon that was ready and then exited before the boot finished as a degraded control plane and exits 1, where it used to leave the daemon out of its line and exit 0. `cotal down` no longer reads a pidless lease row as a live daemon from one read: it waits until the row is written again, which refuses as before, or expires, as a row left by a daemon whose broker stalled past its broker-gone window does, and then goes on.
