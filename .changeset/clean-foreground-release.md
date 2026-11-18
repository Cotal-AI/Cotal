---
"@cotal-ai/cli": patch
---

Stopping a foreground stack with `cotal down` no longer prints a false crash warning, even if the broker needs a force stop. A broker that exits without a stop request still reports a failure.
