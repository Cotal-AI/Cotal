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

Stopping a seat is now a teardown rather than an exit. The cooperative stop and the editor
unloading the plugin run one shared routine, so neither can drift from the other, and it publishes
offline presence in front of the join rather than behind it: a supervised seat is hard killed after
its runtime's grace window, so presence queued behind a long drain is the thing that gets lost.
Queued event work is then given whatever time the runtime allows.

Once that routine has begun, no turn is started, no hook is admitted, and no `cotal_*` tool call
is run. The refusals are stated as a condition on the state rather than as a list of the callers
they cover, which is what let the earlier versions through: a turn could still be started by the
deferred drive a swap fires when its own cutover completes, a late presence event could put a seat
back on the mesh it had just left, and a tool call already inside the model's turn had no way to
know a stop was running. A refused tool call says so rather than returning nothing, because its
caller is waiting on a result and silence would read as a hang.

Admission is what closes; work already inside a hook when the stop arrives is what the join covers,
and the two together are the guarantee.
