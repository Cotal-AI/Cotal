---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The manager's session signing key now renews itself instead of expiring after a day. It was minted
once at startup with a flat 24-hour window and the same frozen anchor was returned for the life of
the process, so any manager with more than a day of uptime lost its session plane permanently: every
attach failed closed with "outside its validity window", and the only recovery was restarting the
manager, which kills every live session. Failing closed on an expired key is correct and is
unchanged; never renewing the key was the defect. The key now rotates once a third of its window has
elapsed, the previous key stays verifiable for a ten-minute overlap so an artifact signed just
before a swap is not orphaned, renewal is driven both by a timer and opportunistically before
signing so a stalled timer alone cannot reintroduce the outage, and the newest key is never dropped.
