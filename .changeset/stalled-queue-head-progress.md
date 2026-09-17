---
"@cotal-ai/connector-core": minor
---

Report a session as stalled when its queue head is not moving, not merely when nothing moves

A session could report `state: ready` with a live transport while its oldest automatic deliveries
were never handed over: one reported seat held 96 of them, the oldest more than two hours old, with
nothing drained for 75 minutes, and every health field green throughout. The stall measure keyed on
any automatic commit, so a seat that kept committing the traffic arriving on top of a head it could
not deliver reset its own clock on every turn and reported healthy indefinitely, while the messages
actually owed to it aged without bound.

Progress is now measured at the head of the automatic queue: the clock resets when the commit takes
the oldest queued delivery, not when it takes any of them. A seat that is genuinely draining still
reports `ready` however busy it is, and a queue that is merely deep was never a stall. The status
route reports `lastAutomaticHeadDrainedAt` beside the existing `lastAutomaticDrainedAt`, because the
gap between the two marks is what names this fault: the first keeps moving while the second stands
still.
