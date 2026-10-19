---
---

The README unicast card now places its durable inbox midway between alice and bob, and ends each wire where the alice-to-bob route leaves the box it meets. The inbox point and the four wire-end offsets used to be hand-written numbers for alice at (100, 410) and bob at (700, 240), so moving either in the shared cast left the inbox at the old midpoint and bent the route there, with nothing failing. With the current cast the inbox does not move and the wire ends move by about two pixels, so the committed `assets/unicast.webp` stays valid. This touches the `remotion/` asset project only; no published package changes.
