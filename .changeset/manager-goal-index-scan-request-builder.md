---
"@cotal-ai/manager": patch
---

`remoteManagerClient` now exports `remoteManagerGoalIndexScanRequest(state, actor, registrationProof, serveEpoch)`, which builds the goal-index scan request the stock manager sends. An embedding that supplies `scanGoalIndex` no longer has to spell the request envelope itself, and the stock manager builds its scan request with the same helper.
