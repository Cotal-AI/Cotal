---
"@cotal-ai/manager": patch
---

A managed agent's retirement is now requested as the manager's SERVE identity, so it is authorized instead of being refused. The auth rail authorizes a `retireLifecycle` request by comparing the caller's `<owner>.<actor>` against the principal bound into the manager's serve issuance gate, and that gate is opened with the serve identity the manager registers with. The request was built from the manager's endpoint identity instead: a second, equally real identity of the same manager, and one the gate can never name. The comparison was therefore unsatisfiable on every user-auth mesh, so every despawn stopped the agent and then had its retirement refused as a full no-op, leaving the name held and the lifecycle un-retired. Both halves of the caller triple now come from the gate's own sources, the owner included, so a manager running under a user-shaped identity cannot re-open the mismatch in the owner half.
