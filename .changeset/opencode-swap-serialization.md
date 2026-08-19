---
"@cotal-ai/connector-opencode": minor
---

Serialize the top-level session swap. The plugin bus does not await the event handler, so a second
top-level session created while the first swap is still draining captured the same holder to
retire and installed its replacement over the first one. The dropped replacement had already been
adopted, which is where its write-ahead log, subject frontier and log open, so it was orphaned
with an open handle and the session it held left a run open on the wire with nothing reporting it.
The holder they both replaced was drained twice.

Swaps now run one at a time, so each reads a holder that is installed and no longer being retired
underneath it, and a rejected swap is absorbed so one failed drain cannot wedge every later swap.
Installed rather than settled: a swap waits for the holder it RETIRES, not for the one it installs,
whose adoption is still starting when the swap resolves.
The connector also logs a retirement the way it already logs an adoption, which is what makes a
retirement that never happened visible at all.

Serializing the swap was not enough on its own, because the session id and the holder that serves
it are two separate things and an event could arrive while they disagreed. Ordering them only moved
the window: with the id assigned before the drain, an event in the gap was carried by the new id
into a holder still bound to the previous session, and that holder refuses a second session
permanently, so the event plane died rather than skipping a frame. Event work is now routed by
asking the holder what it is bound to, so an event reaches a holder only when that holder already
serves its session or serves nothing yet. There is no ordering left for the route to get wrong.

A session that OpenCode attaches to, rather than creates, is also covered. The first event of such
a run arrives before any session was created, and it now reaches the event plane instead of being
dropped, so an attached session publishes from its first turn rather than staying silent until the
next reset.

Stopping a seat is now a teardown rather than an exit. The cooperative stop and the editor
unloading the plugin run one shared routine, so neither can drift from the other, and it attempts
the offline publish in front of the join rather than behind it: a supervised seat is hard killed after
its runtime's grace window, so presence queued behind a long drain is the thing that gets lost.
Queued event work is then given whatever time the runtime allows.

Once that routine has begun, no turn is started, no hook is admitted, and no `cotal_*` tool call
is run. The refusals are stated as a condition on the state rather than as a list of the callers
they cover, which is what let the earlier versions through: a turn could still be started by the
deferred drive a swap fires when its own cutover completes, a late presence event could put a seat
back on the mesh it had just left, and a tool call already inside the model's turn had no way to
know a stop was running. A refused tool call says so rather than returning nothing, because its
caller is waiting on a result and silence would read as a hang.

Departure is also ordered behind the work the seat has already admitted, for as long as a short
bound allows. A presence write is not atomic, so a call admitted before the stop could be parked
mid-write while the teardown published offline, and then put the seat back to work after it had
announced it left; on the wire, a roster read `working` after `offline`. The teardown now waits,
briefly, for interactive work it has already admitted before it attempts departure, and joins the
slower event work afterwards as it already did. Event work is deliberately not in that wait,
because waiting on a drain is what publishing departure early exists to avoid.

That wait is bounded below the shortest runtime grace window, which is what leaves room for
departure to be published before a hard kill under ordinary conditions. It is a margin rather than
a guarantee: the publish itself has no deadline, so a slow write in the time the bound leaves is
lost with everything else the kill takes. The other tradeoff is stated rather than implied: a
straggler that outlives the bound is not cancelled, so it can still complete after departure has
been published.
