---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Reclaim an endpoint governance slot left held by a stopped registration

An instance that stopped between taking the endpoint governance slot and publishing its spec left
the slot held with no registration behind it, and every later registration for that endpoint
refused while nothing was actually in flight. Neither documented recovery reached it:
`cotal reconcile-gate` reopens the holder's issuance gate and does not write the slot, and
`cotal deregister-instance` has no registration to remove.

`registerServiceInstance` now decides whether a foreign-held slot is abandoned instead of refusing
unconditionally. A slot is reclaimable only when the holder's issuance gate has reopened past the
generation the slot is stamped with, which proves the hold can never be promoted, since a promote
requires that same generation still frozen. The holder's gate is read through a new optional
`observeHolderGeneration` seam, mirroring `deregisterServiceInstance`'s `observeGeneration`, and
`readEndpointGateGeneration` is exported for callers to wire it. The manager wires it over the
auth-bucket read its existing registration credential already holds. No new grant and no new writer:
the registration path remains the governance head's only writer.

Everything else still refuses, and the refusals are the point. A slot whose holder's gate is still
at the stamped generation is a live registration and is never taken. An absent seam, an unreadable
gate, a garbled generation, and an observation behind the stamp all refuse. The conflict message
now names a remedy that reaches the state rather than one that does not.

SPEC §13.7 states the liveness guarantee this closes: a registration that stops before its spec
publication must not block an endpoint's registrations permanently, the abandoned determination
must rest on durable facts rather than a liveness probe, and an implementation that cannot make it
must refuse.
