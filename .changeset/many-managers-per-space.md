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

Absence is a determination, not a failure to determine. The delivery-admin rail decodes replies as
JSON, so a peer that merely quotes `no responders` produced a parse failure whose message carried
those words, and the previous text match read it as proof that no daemon was bound, which is the
path that remints. Absence now comes only from the broker's own typed no-responder signal; a parse
failure, a timeout, a denial, and an unreadable reply are each not a determination and never remint.

The store answer is bound to the process that reloads the credentials. That rail is queue-grouped,
so any process holding a `delivery` credential can answer it, while only the delivery lease holder
actually reloads. The daemon's answer now carries the responder's identity and its lease claim, and
a manager refuses to treat a lease-less responder's store as the daemon's.

`smoke:manager-two-root-renewal` proves the two-root composition starts, reminted nothing into
either root, and recorded the owner-elsewhere note; that a foreign manager still reaches its own
renewal duties; that a peer body quoting the absence phrase is never classified as absence; that a
lease-less responder naming the manager's own store is refused; and that a different generation
under the same daemon identity is refused. Its control phase still proves the unified root adopts.
