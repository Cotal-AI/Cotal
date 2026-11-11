---
"cotal-ai": patch
---

Confirm the daemon has stopped before reporting a successful uninstall.

Uninstall keeps a kernel-authenticated connection to the recorded daemon across native service removal, asks a verified native launch to close its own resources, and waits for both its process and endpoint to disappear. Uncertain shutdown retains the source and receipt for inspection instead of leaving an answering orphan behind a successful removal result.
