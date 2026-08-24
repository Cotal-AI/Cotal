---
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
---

Spec text plus one corrected source comment, carried into the embedded docs bundle: the `goaleff` and `epname` value
machines are now stated in the wire spec (phases, states, legal edges, per-phase field sets,
actor roles, and the rule that a settle requires the goal's terminal fact to exist first),
and three key-authority claims are corrected. `epmig` records cutover runs and supplies key
material nowhere else, so the `goaleff` generation token is the accepted submission's EPJ
`sourceSeq` and only that. `goalidx` gets its writer named as the goal-writer principal
rather than the bare commit principal. `effect` is marked as reachable only under
`protocol.v: 2`. The spec also now says explicitly that it does not decide which principal
may act as a sweeper, rather than leaving that to be inferred from a role name. The `epmig` record
kind's own source comment carried the same wrong claim the spec sentence corrects, and is fixed in
the same change so the two cannot drift apart again.
