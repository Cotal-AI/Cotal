---
"@cotal-ai/runtime": patch
---

A `wait` whose bind is refused keeps its position on the channel instead of losing the match.

The handler binds a matched message's stream sequence before acking it, on the argument that a crash
between the two is recoverable. That holds for a crash, which never runs the cleanup. It did not hold
for a `ctx.bind` that FAILS — and a bind is a journal append, which a journal refuses in ordinary
operation (L5010, `RunSuperseded`).

The cleanup deleted the wait's durable consumer on every exit, throws included. So a refused bind
destroyed the only record of where the run had reached on the channel, and the retry — which carries
no recorded sequence, because recording it is exactly what failed — created a fresh consumer at
`deliver_policy: "new"` and found nothing. The matched message stayed on the stream, permanently
invisible to that run, with nothing anywhere red.

A throw is not the wait being over: the step is still pending and someone will retry it. The position
is now kept when the wait unwinds, and deleted only when the wait genuinely ends — matched, timed
out, or idle-fired. Keeping it costs one consumer on a run that is abandoned rather than retried,
which is the cost a host crash already pays and the one the handler deliberately chose over an
inactivity threshold that could reap a live wait's consumer while its host was down.
