---
"@cotal-ai/web": minor
"@cotal-ai/core": minor
---

Parse the dashboard's history limit once, and bound the single-channel read.

Three history routes each re-derived the same limit parse, so a value that was not a whole number
took a different wrong path through each of them. `Number("abc")` is `NaN` and every comparison
against `NaN` is false, so the endpoint's `limit <= 0` guard never fired and its widening history
search could never reach either exit: the read did not return everything, it never returned, and the
abandoned request kept consuming CPU long after its caller had gone. `Infinity` reached the same
hole from the other end and returned a channel's entire retained history.

The limit is now parsed in one place and a value that is not a whole number is refused with a 400
naming what it received, so a caller's mistake is no longer reported as a server fault. The endpoint
refuses a non-finite limit rather than searching forever, which closes it for every caller. The
single-channel history read now carries the same per-request deadline as the aggregate routes, with
a named refusal, because the console view re-reads it on every poll. Zero still means zero, and an
absent or empty limit still means the route's default.
