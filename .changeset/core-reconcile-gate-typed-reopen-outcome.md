---
"@cotal-ai/core": patch
---

`reconcileEndpointGate`, behind `cotal reconcile-gate`, the manager's boot self-heal and the auth host's remote-manager maintenance, no longer reports a completing reopen whose acknowledgement was lost as `raced` with "Nothing was reopened" while the gate is open at the repair's own coordinate. It chose that refusal by matching the error text of `completeFrozenRegistrationFromSpec`, which used one message for a lost reopen CAS and for a reopen whose outcome is unknown. `completeFrozenRegistrationFromSpec` now returns a lost CAS as `{ completed: false, raced: true }`, and the repair refuses `raced` only on that result. A reopen whose outcome is unknown fails with an `unavailable` error that says it may have committed, as the same fault on the abort-reopen path already did, so the boot self-heal no longer continues past it.
