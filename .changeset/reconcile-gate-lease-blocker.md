---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

`cotal reconcile-gate` now names the delivery lease blocker when the delivery daemon gives no liveness verdict. A `liveness-unestablishable` refusal used to advise starting the daemon with `cotal up` whatever the cause. It now reads `lease.0` and reports whether the lease is absent, unreadable, held by a daemon that is not ready, held by a ready daemon while the query went unanswered, or taken by another daemon while the query was outstanding, with the holder, the account, when the holder acquired the shard and when the row was last written. It reads the lease before the query and again after it fails, and names a holder as the blocker only when the same daemon run held the lease both times. For a ready holder it advises re-running before stopping anything, since the rail is queue-grouped and a stopped daemon still subscribed to it can take the query. It advises starting a daemon only when no lease exists. A row whose times are not valid dates reads as unreadable instead of failing the command. An explicit daemon refusal keeps its own reason and adds the same lease line. The manager's boot self-heal uses the same probe and reports the same line. The refusal, exit code 2 and the frozen gate are unchanged.

The delivery lease row now carries `acquiredAt`, set when a daemon's acquisition of the shard succeeds and kept on every ready flip and renewal, while `since` still records the latest write. Rows from older daemons have no `acquiredAt`. `docs/cli.md` lists the lease readings.
