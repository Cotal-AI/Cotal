---
"@cotal-ai/delivery": patch
---

Restore the handover scenario cell F of the delivery starvation suite is about. Since the daemon began acting on the lease-watch event rather than waiting for its renew tick, a running holder re-took a deleted row before the replacement had finished starting, so there was no loser and three cells passed by reading the holder's own lease. F now freezes the holder across the handover the way cell G already did. Two matching repairs alongside it: the four wordings a losing daemon uses are one constant, since the lease-watch exit says the key was read `as held by` someone where the cells matched only `is held by`; and the suite waits for `close` rather than `exit` before grading a transcript, because a losing daemon's last line is the one naming who took its shard.
