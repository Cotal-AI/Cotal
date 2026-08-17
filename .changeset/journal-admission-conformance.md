---
"@cotal-ai/core": minor
---

Journal-class admission: enforce the fourth I-JSON condition, key the admission ceiling on the
class rather than the action marker, hold decision facts to the idempotency horizon, and register
the three coordination record kinds with their commit-path grants.

Out-of-range numbers are now quarantined. `JSON.parse("12345678901234567890")` yields
`12345678901234567000` and reports nothing, so a submission was admitted and its durable decision
bound a value the caller never sent. The check reads the raw bytes, because the parse destroys the
evidence, and its predicate is round-trip stability rather than magnitude: `0.1` is inexact in
binary and perfectly legal, while a literal that cannot survive text to double and back is not.

The admission ceiling is required on every journal-class command instead of only on those carrying
the action composite. A journal-class command without the marker was accepted with no ceiling and
refused if it declared one, though the journal rail's bind rows are derived from the class and
never from the marker.

`createEndpointStreams` now refuses a fact retention below the declared idempotency horizon. The
horizon is realized by retention rather than by a clock, so a shorter age does not shorten a
guarantee; it removes the mechanism, and a redelivered submission whose decision fact has been
evicted is accepted as new work. The horizon is a declared option defaulting to the documented
constant.

`goaleff`, `epname` and `epmig` are registered record kinds, and the commit path's grant enumerates
each at its own width. Registering a kind does not grant it, and a kind absent from that
enumeration is denied however it is registered.
