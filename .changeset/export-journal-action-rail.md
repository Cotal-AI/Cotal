---
"@cotal-ai/core": minor
---

Export the journal action rail from the package barrel, so a consumer can actually reach it.

`endpoint-goaleff`, `endpoint-epname` and `endpoint-effects` shipped as package-private modules.
They carry the durable action machinery the journal rail is built on: the at-most-one-launch
election and its edge assertion, the endpoint name claim and its edge assertion, and the effect
decision. Every sibling `endpoint-*` module is re-exported from `index.ts`; these three were not,
so `@cotal-ai/core` did not expose the surface they exist to provide and nothing outside the
package could import them. That was an omission rather than a decision: no consumer had asked for
them yet, and nothing failed while none did.

The freeze guard could not have caught it, and its green was not evidence either way. That scan
walks exported arrays and plain objects to prove each is deep-frozen; all five of these exports are
functions, so the scan is structurally blind to them and reports the same 18 arrays and 12
plain-objects whether or not the modules are exported at all. A guard that cannot distinguish the
change from its absence is silent about it, not supportive of it, and reading its pass as coverage
is how an omission like this survives.

So reachability is now asserted directly rather than inferred from that pass: each module's runtime
exports must be identical, by reference, to the barrel's same-named export. This reuses the identity
technique the suite already applies to its allow-listed re-export subpath. Dropping any one of the
three export lines reddens that module's named cell and only that cell.
