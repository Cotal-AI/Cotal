---
"@cotal-ai/cli": patch
---

`cotal status` now says in plain words when the delivery daemon died and its lease has not expired:
how long the lease lasts, that spawn, retirement and the durable backstop wait until a new daemon
binds, that joins, DMs and live posts can still work, and that `cotal up` restarts it. It said that a
dead daemon's ready record still held the lease.
