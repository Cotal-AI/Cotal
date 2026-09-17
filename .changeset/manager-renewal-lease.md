---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Serve a space from more than one manager, with one renewal owner

A manager whose workspace root differed from the delivery daemon's was refused at construction, so
an auth-mode space could only ever have one manager. A participant machine could not run a manager
for a space it had joined, and a second manager on one machine from another checkout could not start
either.

The store-identity proof stays and still runs before every remint, but a divergent answer now
decides ownership rather than admission. That alone is not enough: the comparison is pure equality
with no holder and no tiebreak, so every manager sharing one store passes it, and two owners
reminting on independent timers have no ordering between them. One write then lands between the
other's re-sign and its fingerprint-only `reloadCreds`, which is the adoption refusal the proof
exists to prevent.

Ownership therefore requires both the identity match and a per-space renewal lease, one
CAS-acquired key in the manager bucket. The lease is kept alive against that bucket's TTL and
claimed before the first remint, because that remint re-signs through the store and on a slow store
outlasts the TTL by itself. A holder that dies has its lease expire so a survivor takes over with no
operator step, and a clean stop hands it back at once. A manager that owns neither condition starts,
serves its seats, skips the remint, and writes no renewal record because it re-signed nothing.
