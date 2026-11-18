---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Shared CLI installations now distinguish home-local connector reconciliation from updating the CLI itself.
Keep ordinary per-home reconciliation and name `cotal update` for stale local inventories. Automatic generation migration leaves a shared canonical connector graph used by an older recorded local Manager unchanged, reports that its connectors stay at their version until restart, and lets the ordinary command continue. Explicit reconciliation stays strict. A validated separate release selection can reconcile without changing that Manager's graph.
