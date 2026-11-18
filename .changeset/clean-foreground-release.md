---
"@cotal-ai/cli": patch
---

Stopping a foreground stack from another terminal no longer prints a false broker crash warning, even if `cotal down` needs to force the broker to exit. A broker that exits unexpectedly during startup still reports a failure.
