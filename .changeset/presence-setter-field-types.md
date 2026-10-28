---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

`CotalEndpoint.setActivity`, `setStatus`, `setCondition` and `setAttention` and the `MeshAgent` presence wrappers now check `status`, `activity`, `attention` and `condition` against the same `presenceShapeProblem` guard that `isPresenceRow` runs on readers before changing local state or publishing, and throw a `TypeError` naming the field. Previously, passing a non-string `activity`, `attention` or `condition.code` resolved and wrote a row that every reader dropped with a warning, making the still-heartbeating publisher appear offline on every other roster.
