---
"@cotal-ai/manager": patch
---

`cotal reconcile-gate` now names the delivery lease blocker when the delivery daemon gives no liveness verdict. A `liveness-unestablishable` refusal used to advise starting the daemon with `cotal up` whatever the cause. It now reads `lease.0` and reports whether the lease is absent, unreadable, held by a daemon that is not ready, or held by a ready daemon that did not answer, with the holder, the account and when the row was last written. It advises starting a daemon only when no lease exists. An explicit daemon refusal keeps its own reason and adds the same lease line. The manager's boot self-heal uses the same probe and reports the same line. The refusal, exit code 2 and the frozen gate are unchanged. `docs/cli.md` lists the lease readings.
