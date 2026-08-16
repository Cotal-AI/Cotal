---
"@cotal-ai/runtime": minor
---

A run adopted at a new epoch re-arms its pauses — including a `wait`'s — without being wired to.

Two defects, both found by review, both about the same moment: a driver taking a run over from
another host. A checkpoint's armed schedule fires onto a subject derived from the instance and epoch
that armed it, so an adopted run's timers fire where nobody is listening, and replaying the program
does not repair that — the pause replays as pending and goes straight back to waiting.

**A pending `wait` was not counted as an outstanding pause.** The re-arm list enumerated the kinds
that MINT a pause — `sleep` and `checkpoint` — and `wait` mints none, so it did not look like one.
It arms mediated deadlines all the same: its idle window, its timeout, or both. A `wait` adopted at
a new epoch was left on a deadline no live epoch would ever fire, so the run waits forever and
nothing anywhere is red. An idle wait with a timeout arms two deadlines and the second is derived
rather than recorded, so the repair re-derives it, exactly as the live path does.

**The repair seam had no caller.** `onActivated` was an optional callback and nothing in the tree
passed one — not a production path, not the driver's own suite — which at runtime is
indistinguishable from a driver that has nothing to repair. A handler that owns external state now
declares an `adopted` method and the driver calls it when no callback is supplied. The driver still
only decides WHEN; what to repair remains the handler's business. An explicit `onActivated` still
wins, and a handler that owns nothing external still needs no method.
