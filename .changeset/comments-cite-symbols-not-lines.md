---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

Comments in core, the manager and the runtime cite SPEC sections and code symbols instead of line numbers. Nine of those line numbers pointed at unrelated text, including the `EpGateState.space` doc in core's published types, which also named §13.9 for the per-space auth bucket that §13.12 defines. The comments now name the alias-reuse gate in the manager's spawn path, `resolveService`'s `instanceId` option and the `pinnedInstanceId` it returns, the spawn affinity gate, the auth session ledger's `reconcileSessionForTakeover`, and each SPEC section without a line. No behavior changes.
