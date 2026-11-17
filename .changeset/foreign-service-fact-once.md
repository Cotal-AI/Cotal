---
"cotal-ai": patch
---

Self-update reports a stopped service owned by another installation once.

The reconcile child honors the updater's existing reporting marker for this fact. A child started by an older updater without that marker still reports it. Service ownership checks and stopped-service behavior are unchanged.
