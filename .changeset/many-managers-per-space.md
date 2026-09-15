---
"@cotal-ai/manager": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Many managers per space, on the same device or different ones

A space has many managers. Since the #773 fix, a manager refused to start unless its SecretStore
was the one the delivery daemon reloads from, which on an auth-mode space meant one manager per
space, on the daemon's host, from the daemon's root. A second manager on a laptop, or a second
root on the same machine, was impossible.

The manager now classifies the daemon's reload store instead of refusing it. A manager whose store
is the daemon's is the daemon-cred renewal owner and remints as before, with fingerprint-only
adoption. A manager whose store is foreign starts, serves seats, never remints daemon creds (a
generation written where the daemon cannot read it was the original #773 defect), and records in
its renewal record that renewal is owned elsewhere, naming both stores. `cotal doctor auth` renders
that as owned elsewhere, not as a problem.

Every manager of one space must serve identical contracts. SPEC 13.7 requires
contract-homogeneous classes: an incompatible generation registers a distinct routable identity
until the class is homogeneous again. A heterogeneous class drops `ps` censuses and produces false
`no managed agent` refusals.

A foreign classification skips the daemon remint and nothing else. It establishes only that the
daemon's credentials are renewed elsewhere, and says nothing about the credentials a manager owns
outright: its managed-agent statics, its endpoint-serve credential, its goal-writer, its hosted
runs, and its session ledger, none of which any other process renews. Those duties now run on a
foreign manager, and on a pass whose store challenge failed. On a 24-hour class renewed on a
quarter-TTL tick, the previous behaviour looked green for a full day before the manager died at its
own credentials' expiry.

Absence is a determination the manager makes for itself, from a fact no responder can send. The
delivery-admin rail is queue-grouped, so any process permitted to serve it decides what a requester
observes, and that includes the outcome a requester would read as an empty rail: a NATS client builds
its typed no-responder error out of a reply carrying an empty payload and a 503 status header, so a
responder that does not hold the delivery lease can produce it. Testing the rail's own outcome cannot
separate the two cases, at any level of precision, because a responder is what produces that outcome.
So the manager reads the delivery lease row itself, under its own credential, and classifies absence
only when no daemon holds the shard. A rail that produces nothing while a lease is live is refused and
named, and a lease row that cannot be read is undetermined. Neither remints.

The lease claim is bound to something the manager verifies rather than to a boolean the reply asserts.
The daemon's answer still carries the answerer's identity and its own lease claim, but a claim is a
value the answerer chose, and a responder that does not hold the lease can assert it as easily as an
honest one reports the truth. The manager reads the lease row's recorded holder and requires the
answerer to be that principal; the reply's own claim is kept as a cross-check that must agree, so an
honest non-holder is still refused by its own admission, but the binding that decides is measured
locally. Managers carry a read-only keyed grant on the delivery bucket for those two reads. The lease
keeps its single writer, the `delivery` credential, because a credential able to write the row could
manufacture the fact the check reads.

`parseDaemonStoreAnswer` now refuses an unknown top-level key instead of ignoring it, matching the
closed-parser discipline its own documentation claimed and `parseSecretStoreIdentity` already had.

`smoke:manager-two-root-renewal` proves the two-root composition starts, reminted nothing into
either root, and recorded the owner-elsewhere note; that a foreign manager still reaches its own
renewal duties, and so does a pass whose store challenge failed to reach a verdict; that neither a
peer body quoting the absence phrase nor a peer reply in the empty-payload-plus-503-status-header
shape is ever classified as absence; that a lease-less responder naming the manager's own store is
refused, whether it answers honestly or asserts the lease claim outright; and that a different
generation under the same daemon identity is refused. Its control phase still proves the unified root
adopts. `smoke:delivery-lease-grant` proves the manager's new read is present and stays read-only.
