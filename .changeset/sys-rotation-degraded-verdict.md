---
"@cotal-ai/cli": patch
---

The `$SYS` rotation smoke now reads the delivery daemon's degraded membership verdict (`graph membership degraded`) after `up --rotate-sys`, where it used to fail on any `! membership:` line. The manager's first renewal pass re-signs the feed's rw cred seconds after boot and forces a reconnect of its data connection, and a sweep inside that gap logs a transient `CONNZ sweep omitted our own rw connection` notice that the old pattern read as degradation. Because that notice path never reports degraded, the smoke also requires the feed's heartbeat to advance after the renewal pass, so a feed that keeps omitting its own connection still fails. No behavior changes.
