---
"@cotal-ai/cli": patch
---

Automatic connector reconciliation after self-update keeps its seed children on the same installed selection.

A version-changing update can leave the CLI running a retained package. Its seed child now re-enters through the parent's logical installed entry instead of treating the retained package as another installation. Other re-execution callers and the seed custody checks are unchanged.
