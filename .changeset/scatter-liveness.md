---
"@cotal-ai/core": minor
---

Let a class scatter stop waiting on an instance the broker says is gone.

A scatter's gather has two exits: every frozen slot answered, or the deadline. The expected set is
frozen from the service registry, which records registration rather than liveness — and an instance
that crashes never deregisters, so its record stays `ready` indefinitely. That leaves a slot which
can never answer, which makes the first exit unreachable, so the deadline is paid in full on every
scatter in the space, for as long as the dead record survives. Measured on a live mesh with three
registered managers and one true corpse: `cotal ps` at 13.8s, of which the scatter was 8.38s against
its 8000ms budget.

`epScatter` now takes an optional `probeLiveness` hook and ends the gather once every frozen slot has
either produced a valid reply or been affirmed gone. It moves the classification point and nothing
else: an affirmed-gone slot is still `missing`, still surfaced, still not `complete`, and a straggler
arriving after an early finish is still reported `late` rather than dropped.

Only the verdict `gone` licenses anything. `live`, `unknown`, a hook that throws, and any value
outside the closed set all leave the full deadline standing. That asymmetry is the safety argument
rather than a defensive default: a broken or silent probe degrades to exactly the previous behaviour,
never to a fast wrong answer. The failure it exists to prevent is real and was measured on the mesh
this was built against — the manager actually running the space both drops out of presence
periodically and needs about a second to answer, so a rule keyed on a lapsed presence entry would
have reported the one live manager as unreachable, faster than the current code produces the right
answer.

`epProbeInstanceInterest` supplies the verdict from the broker itself: a `describe` cast on the
instance's own rail with the reserved no-responders sentinel as its reply-to, the same primitive and
the same trust rule `epCall` already relies on (no responder holds a publish grant for that subject,
so a 503 there is the broker's own frame). A serving incarnation subscribes its instance rail for
every command it serves and every endpoint must serve `describe`, so silence on that rail is evidence
of absence rather than absence of evidence. The reply is never read, so an instance whose describe is
broken still reads as present.

`instancePinnedInstrumentCapabilities` accepts several instance ids as well as one. Each still emits
its own concrete rows; no wildcard instance is minted, so the existing no-wildcard boundary on
instance addressing is unchanged.

A scatter with no probe wired behaves exactly as before. This does not help against an instance that
is connected but not answering: a hung responder holds its subscriptions and is indistinguishable
from a slow one, so it still costs the full deadline, which is the correct result.
