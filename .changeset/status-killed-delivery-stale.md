---
"@cotal-ai/cli": patch
---

`cotal status` no longer reports the delivery responder as bound right after the delivery daemon is killed. The dead daemon's ready row stays in the lease for up to 30 seconds and names this folder's own credential, so status read it as healthy while the same report showed the delivery process gone. When this folder's delivery pidfile names a process that has exited, status now reports that row as `stale`: not bound, a dead daemon's record that expires on its own.
