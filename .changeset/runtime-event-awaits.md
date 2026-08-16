---
"@cotal-ai/runtime": minor
---

Add durable event awaits to the workflow runtime. `wait(message(channel, …))` and
`wait(idle(channel, duration))` now run on the real planes: the consumer holding a run's position on
the channel is durable and named from the step's own request id, created before the wait begins, so
an event published while the waiting host was down still answers the wait when the run comes back.
An ephemeral consumer, or one created on resume, silently starts from "now" — the event is not lost,
it simply never happened as far as that run is concerned, and nothing goes red.

The timeout rides the checkpoint plane and is therefore durable too: minted once with an absolute
deadline, so a wait that spans a crash resumes against the deadline it was given rather than
restarting the clock. It resolves `null` and never throws. `idle` is that same plane extended rather
than replaced — a deadline traffic pushes out through the checkpoint heartbeat — and any traffic
resets it, matched or not, because idle is a fact about the channel and not about the messages one
program finds interesting. An answered wait claims its own timeout rather than leaving a timer armed.

`replied(agent)` and `down(agent)` refuse through a named `NotYetDurable` seam. They are gated by
their input rather than their mechanism: an agent handle comes from `spawn`, and `down` additionally
needs `monitor` to have registered interest. The simulator performs them, so a program using them
can be written and dry-run today; a durable run refuses rather than performing an effect it could
not recover after a crash.
