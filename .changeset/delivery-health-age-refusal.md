---
"@cotal-ai/core": minor
---

An affirmative delivery-health surface, and an age that cannot be established is now a refusal

`@cotal-ai/core` gains a delivery-plane health surface that answers "is delivery actually
working right now" affirmatively, or names which condition failed. Liveness is a message the
daemon produced in response to this question — explicitly not that a process exists, not that
the broker is reachable, and not that the lease reads ready. A daemon that is present but
wedged satisfies all three of those and answers nothing; that state is constructed against a
real daemon in the accompanying suite, and the round-trip is what catches it.

Every reported fact carries its source and its age, so a stale answer cannot render as a
current one, and each refusal names its own condition rather than degrading into a shared
"unknown" that a reader takes for "fine".

**Breaking:** `HealthFact.ageMs` is now `number | null`. It is `null` when the age cannot be
established, which happens when the evidence is stamped after the moment it was read. The
previous shape clamped the difference to zero, and because the evidence timestamp comes from
the writer's clock rather than the reader's, a writer running ahead reported an age of zero —
which is exactly what a live round-trip produces. Stale evidence of any age was therefore
indistinguishable from an answer that had just arrived.

That was not only a rendering fault. Lease staleness is gated on the age exceeding the TTL, so
a clamped zero passed the gate that the age exists to drive, and a lease of any age was
accepted as fresh whenever its writer's clock ran ahead. Refusing to age the pair, rather than
defending against the negative number, is what closes it.

Consumers reading `ageMs` must narrow before comparing or formatting it. Note that the type
alone does not enforce this at every site — a `null` interpolates into a template string
silently — so rendering goes through a helper that says the age could not be established
instead of printing the value.

Clock disagreement is its own refusal condition rather than a variety of lease staleness. The
two are opposite kinds of fact: one asserts the heartbeat is known to be older than the TTL,
the other that no age is knowable from the two clocks at all. Reporting the second under the
first left the machine-readable condition false while only its free-text detail was true, and
a detail cannot correct a discriminator that consumers switch on.
