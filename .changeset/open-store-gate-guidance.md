---
"@cotal-ai/manager": patch
---

A manager on an open mesh that stops on a frozen registration gate now says why it cannot be repaired there. This happens in an open store where an earlier build staged manager credentials. The first boot's refusal still names the holders it could not verify gone, and the later boots' frozen-gate refusal no longer advises `cotal reconcile-gate`. Both now say that reconciliation needs liveness evidence an open mesh cannot currently provide, that `cotal manager reconcile` refuses the gate, and that the store should be kept intact because upgrading alone does not recover it. Error codes, the gate, the revocations and eviction checks, and the stored state are unchanged.
