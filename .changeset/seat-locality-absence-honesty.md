---
"@cotal-ai/cli": minor
---

A seat is reported as not found only when every reachable manager instance answered for itself

`cotal stop`, `cotal attach` and `cotal input` locate a seat by asking every registered manager
instance which one hosts it, because a single manager answers `not-found` both for a seat it does
not host and for a name that exists nowhere. That search concluded absence from every instance the
scatter called reachable. An instance that answered with a REFUSAL is reachable, and it stated
nothing about which seats it hosts; an instance that never answered at all was left out of the
count entirely. So an incomplete search printed a definite negative that named the instance count,
which is the shape a reader believes: a seat that `cotal ps` listed as running the whole time was
reported as being on none of the reachable managers, and the same command with `--on <instance>`
succeeded first time.

Absence is now concluded only from instances that answered for themselves. When any registered
instance stayed silent or refused the read, the verbs report that the seat's location could not be
established, name those instances, and state that this is not a report that the seat is gone, so an
operator or a retry loop pins with `--on` instead of concluding the seat is already gone. A search
in which every instance answered still reports the seat as absent, unchanged.
