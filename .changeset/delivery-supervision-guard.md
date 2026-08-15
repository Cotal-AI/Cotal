---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

delivery: an affirmative, report-only supervision guard for the Plane-3 daemon

The delivery daemon had no supervision guard. `startDeliveryDetached` spawns it with
`detached: true` and calls `child.unref()` — an explicit release, with no exit handler and no restart
path — while the manager registers an exit handler for every agent node it spawns. The daemon was
the one child nobody watched, and when it died, senders were still told their messages had been
sent.

Adds `delivery-guard`: it takes bounded observations of delivery health and reports what it saw. It
observes and reports; it never starts, stops, or restarts anything. A watchdog that can start
processes is a new failure mode with a new blast radius, and the daemon already fail-closes when a
live lease exists, so a restarter racing that check would produce a double-launch.

Liveness is always an affirmative round-trip the daemon itself answers — never a pidfile, a process
check, or a lease inside its TTL. Measured against a real daemon, a SIGSTOPped one satisfies every
one of those while answering nothing, so a guard built on them would pass a wedged daemon forever.

Every report carries the guard's own last-observation time and age, and a guard that has not
observed recently enough refuses by name rather than repeating the last thing it happened to see. A
guard that only speaks when something is wrong is indistinguishable from a guard that has died,
which is the original incident one level up. There is no bare "unknown" state, because a reader
takes "unknown" for "fine", and the report distinguishes "the daemon is down" from "I cannot tell
you whether the daemon is down" — different facts an operator acts on differently.

`@cotal-ai/core` now exports `./health.js` (`DeliveryHealth`, `HealthFact`, `renderHealth`,
`assessDeliveryHealth`). It was deliberately unexported while nothing read it; the guard is the real
consumer that condition was waiting for.

The ready card now carries a DELIVERY row, so an operator can ask "is delivery actually working
right now" and get an answer that was earned. `✓` is reachable only from an affirmative round-trip
inside a current observation; every other path renders `?` (never dim), names which condition
failed rather than a bare unknown, and carries the fact's source and its age.

The row's caller is agent-class, and which class it should be was measured rather than assumed. The
tempting reuse — `control-caller-privileged`, already minted by the manager row — is denied at the
broker on the delivery-lease read, so reusing it would have made the row report an unreachable
daemon on a healthy mesh: "the daemon did not answer" when the truth is "I was never permitted to
ask". Driven live against a real daemon, `refused` and `no-responder` are distinct conditions, so
the row can tell a denial from an absence.
