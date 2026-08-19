---
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-core": minor
---

Serialize the top-level session swap. The plugin bus does not await the event handler, so a second
top-level session created while the first swap is still draining captured the same holder to
retire and installed its replacement over the first one. The dropped replacement had already been
adopted, which is where its write-ahead log and subject frontier are opened, so it was orphaned
with an open handle and the session it held left a run open on the wire with nothing reporting it.
The holder they both replaced was drained twice.

Swaps now run one at a time, so each reads a holder that is installed and no longer being retired
underneath it, and the chain carries the absorbed tail of each swap, so the next one still runs
after a failed drain.
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
serves its session or serves nothing yet.

A session that OpenCode attaches to, rather than creates, is also covered. The first event of such
a run arrives before any session was created, and it now reaches the event plane instead of being
dropped, so an attached session publishes from its first turn rather than staying silent until the
next reset.

Stopping a seat is now a teardown rather than an exit. The cooperative stop and the editor
unloading the plugin run one shared routine, so neither can drift from the other, and it attempts
the offline publish in front of the join rather than behind it: a supervised seat is hard killed after
its runtime's grace window, so presence queued behind a long drain is the thing that gets lost.
Queued event work is then given a bounded chance to settle inside whatever time the runtime leaves.

Once that routine has begun, the connector starts no turn of its own, admits no hook work, and
runs no `cotal_*` tool call. That first part now holds for a drive that was ALREADY PAST the check
as well, which it did not before: the guards were read once, session creation was awaited, and
nothing looked again, so a turn admitted while the seat was healthy could be submitted after
departure had published. The phase condition is one predicate now, read on the way in and again on
the way back from that await, and a drive refused there consumes nothing, so the batch is still in
the inbox for a later wake in the same process.

Separately, the operator's spawn prompt is no longer lost when something else gets in front of it.
The boot task used to clear the prompt and then ask for a turn; if a natively submitted prompt had
already made the session busy, that request returned early and the text was gone. The text is now
cleared only once it has actually been submitted, and it counts as pending work everywhere the
connector asks whether there is anything to drive, so being beaten to the session costs a retry
rather than the prompt. What it does NOT do is cancel the editor. A hook steers
OpenCode by mutating its `output` argument rather than by what it returns, and `chat.message`'s
output carries no field that cancels or skips a turn, so a prompt submitted natively through the
editor or its API still starts one. Whether that turn's events reach the plane is timing rather
than a rule: the endpoint stays up until the end of the routine, so work already queued can still
settle, while work arriving after the fence closes is refused. The refusals are stated as a condition on the state rather than as a list of the callers
they cover, which is what let the earlier versions through: a turn could still be started by the
deferred drive a swap fires when its own cutover completes, a late presence event could put a seat
back on the mesh it had just left, and a tool call already inside the model's turn had no way to
know a stop was running. A refused tool call says so rather than returning nothing, because its
caller is waiting on a result and silence would read as a hang.

The same loss had one more door, and that one is a failure rather than a refusal. Every refusal
above leaves the drive through a guarded return, where the input it was carrying is put back by
hand. A submission the host rejects leaves through the error path instead, and that path put nothing
back. It looked safe only because most inputs are parked somewhere else already: the wake for an
@mention in focus is not, because its body is acked at ingest and stays recallable while the wake
itself lives only in the string handed to that one drive. So a rejected submission destroyed the
wake, and the retry that exists for exactly this case then saw no pending work and did not run,
leaving a seat that was never told to go and look. The error path now parks its input like every
other exit, so a failed submission costs a retry rather than the wake.

One slot, and one caller clearing another caller's wake. The three exits above each put their input
back by hand, but they all put it in the SAME place, and the clear that runs after a successful
submission sat on the far side of an await. A drive parked in session creation had read its input
before that await; a second caller then reached the entry guard, parked its own wake in that slot and
returned; and when the first call finally submitted, it emptied the slot on the strength of what IT
had taken. That is a lost update across an await, and it destroyed a wake that arrived through
exactly the guarded exit these changes exist to protect. The clear is now ownership checked, by
generation rather than by value, because the nudge names the sender and not the message, so two
mentions from one sender are byte identical and comparing them would report "still mine" about
someone else's input.

A wake could also be destroyed before it ever reached that slot. The handler for an @mention in
focus declined to ask for a turn while one was already running, which is the right thing to do one
handler above it, where the message is buffered in the inbox and the next turn picks it up. This
one has nothing buffered behind it: the body is acked and dropped as it arrives, so the nudge is
the only copy, and declining did not defer it, it discarded it. The turn then ended, found nothing
pending, and the seat was never told it had been mentioned at all. That wake is now handed over
whatever the seat is doing, so a busy seat parks it and drives it when the turn ends.

What that does and does not promise, stated narrowly on purpose. It does NOT prevent message loss:
an @mention in focus is acked at ingest, and where the channel permits replay its body stays
recallable from the server, so the content was never riding on the wake. Where a channel denies
replay, the body is gone by that channel's own policy and no wake can bring it back; the connector
deliberately does not buffer it, because doing so would hand a seat in focus history that the
channel refuses to everyone else. What this prevents is a caller's wake being erased, whether by an
unrelated call's clear or by a handler that never passed it on. One slot is the design rather than
a limit: a later wake overwriting an earlier one costs nothing, because any single wake that fires
makes the seat pull its inbox and recover whatever that channel will give back, while emptying the
slot entirely means no pull is ever triggered. The invariant is that at least one wake survives to
fire, not that every wake is kept.

Departure is also ordered behind the work the seat has already admitted, for as long as a short
bound allows. A presence write is not atomic, so a call admitted before the stop could be parked
mid-write while the teardown published offline, and then put the seat back to work after it had
announced it left; on the wire, a roster read `working` after `offline`. The teardown now waits,
briefly, for interactive work it has already admitted before it attempts departure, and joins the
slower event work afterwards as it already did. Event work is deliberately not in that wait,
because waiting on a drain is what publishing departure early exists to avoid.

That wait is for the whole admitted set rather than for the first thing to happen to it, and it says
so with `Promise.allSettled` rather than by absorbing each call by hand. The hand-rolled version was
the same defect one level up: a map can absorb SOME elements, and a review proved by live mutation
that absorbing only the two ends passed every cell the suite had at the time. The primitive waits for
every element and never rejects, so partial absorption is no longer a state this code can be in.

That wait is bounded below the shortest runtime grace window, which is what leaves room for
departure to be published before a hard kill under ordinary conditions. It is a margin rather than
a guarantee: the publish itself has no deadline, so a slow write in the time the bound leaves is
lost with everything else the kill takes. The other tradeoff is stated rather than implied: a
straggler that outlives the bound is not cancelled, so it can still complete after departure has
been published.

A wake that arrived before the boot prompt used to starve both of them, permanently and silently.
The two share one slot: the boot text was carried only when that slot was empty, so a focus
@mention landing while the boot task was still waiting for the session parked the nudge, and the
boot task's own request then read that nudge, put it straight back and returned. Nothing could
empty the slot afterwards, because emptying it takes a submission, a submission takes the boot text
cleared, and clearing it takes the submission that had just been refused. The seat stayed online
with nothing logged and no retry scheduled, and it went deaf: the spawn prompt, the wake, and every
later connector-submitted turn including a directed message were all lost for the life of the
process. Against the previous release this was a regression, which lost the wake and still
submitted the boot. The two now go out together in one turn rather than competing for the slot. The
boot floor says the operator's prompt is the first turn this connector submits, and a wake says
only that the seat should go and look, so there is nothing to order between them.

The event plane also gives back what a session took on disk, which is the other half of a `/new`
and the half that is not visible on the wire. Two things are created for a session that publishes
events and they have different lifetimes, so they are released differently.

The principal lock is per principal and per workspace, shared by every session of that agent. It
was taken and never given back: the connector read the location it came with and dropped the lock
itself, so nothing in shipped code released one. The record then went on naming a process that was
alive and no longer publishing, and a REPLACEMENT process for the same principal was refused its
own event plane. It is now released at the final event teardown and only there, since a `/new`
must keep it for the session that follows. Both ways out reach that teardown, so the editor
unloading the plugin while its host keeps running releases it exactly as a supervised stop does.

A session's write-ahead log is per session and its lifetime is stated rather than assumed, because
a log exists so a later start can recover what was not yet published and deleting one early
destroys exactly that. A retired session's log is removed once its run has been closed on the wire,
AND the drain that closed it settled rather than spending its bound, AND the log holds no frame the
broker never confirmed. Either of the last two keeps it, for different reasons that the connector
distinguishes in what it logs: an abandoned drain is uncancelled and may still be writing, while a
pending frame is the one thing only a later start reading that file can settle. The live session's
log survives teardown, because a teardown is not a retirement: nothing has told an observer that
thread ended, and a start that adopts it again is the case the log is for. So a process leaves one
log directory behind rather than one per `/new`.

`@cotal-ai/connector-core` gains a close on the emitter holder to go with that. Retiring a holder
was a dropped reference rather than an act: it refused nothing afterwards, and a late hook could
still start or pump an emitter its owner had finished with. Closing refuses admission and then
joins what is already queued. It cancels nothing and releases no durable state, because the log's
lifetime and the lock's are the connector's to decide and not the holder's.
