---
"@cotal-ai/cli": minor
"@cotal-ai/delivery": minor
"@cotal-ai/workspace": minor
---

Make the delivery daemon own its liveness record

`delivery.<space>.pid` was written only by the CLI launcher, so a daemon started by any other route,
a container entrypoint, systemd, or an operator running `cotal deliver --space <space>`, left
whatever was on disk untouched and every reader believed it. On a reporting mesh the record named a
pid that had been dead for four days while the daemon ran under a different one.

That is not only an under-report. `cotal down` decides what to stop from the same record, and
`mayBeRunning` is the guard that must fail closed so `cotal down nats` cannot take the broker away
from a live dependant. A record naming a dead pid satisfies that guard: it supplies the
proof-of-death the guard asks for, so a live delivery daemon reads as clear and the broker goes out
from under it.

The daemon now writes its own record and removes it, with the identity pin, when it exits. The write
happens once the single-flight shard lease is held, and not before: a daemon that loses that lease
refuses to bind and exits, so writing on entry would let a loser overwrite the live holder's record
on its way out. It is written before the Plane-3 bind so an operator can still stop a daemon whose
bind hangs; readiness is a separate fact the lease's own flag already carries.

Readers no longer believe a pid merely because it is alive. The delivery record's liveness gains the
`foreign` state the manager's already had, for the same reason: a record that outlived its daemon is
eventually re-pointed at an unrelated process by pid reuse, and `kill(pid, 0)` alone reports that
stranger as a healthy daemon forever. A live pid is trusted only once its command line has been read
and names the daemon, and `cotal down` never signals a live process that is provably not one.
Attribution only downgrades on proof, so a platform with no argv source, an unreadable process, or
one that exits during the read all behave exactly as before.
