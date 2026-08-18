---
"@cotal-ai/connector-opencode": minor
---

Serialize the top-level session swap. The plugin bus does not await the event handler, so a second
top-level session created while the first swap is still draining captured the same holder to retire
and installed its replacement over the first one. The dropped replacement had already been adopted,
which is where its write-ahead log, subject frontier and log open, so it was orphaned with an open
handle and the session it held left a run open on the wire with nothing reporting it. The holder they
both replaced was drained twice.

Swaps now run one at a time, so each reads a holder that is already settled rather than one
mid-retirement, and a rejected swap is absorbed so one failed drain cannot wedge every later swap.
The connector also logs a retirement the way it already logs an adoption, which is what makes a
retirement that never happened visible at all.

Serializing the swap was not enough on its own, because the session id and the holder that serves
it are two separate things and an event could arrive while they disagreed. Ordering them only moved
the window: with the id assigned before the drain, an event in the gap was carried by the new id
into a holder still bound to the previous session, and that holder refuses a second session
permanently, so the event plane died rather than skipping a frame. Event work is now routed by
asking the holder what it is bound to, so an event reaches a holder only when that holder already
serves its session or serves nothing yet. There is no ordering left to get wrong.

A session that OpenCode attaches to, rather than creates, is also covered. The first event of such
a run arrives before any session was created, and it now reaches the event plane instead of being
dropped, so an attached session publishes from its first turn rather than staying silent until the
next reset.
