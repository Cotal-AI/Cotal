---
"@cotal-ai/cli": patch
---

Keep the manager's delivery-aware marker, shutdown intent and spare capability when `cotal down` does not stop every selected component. The manager stop no longer removes them itself: `down` removes them after its all-stopped gate, and the `cotal up` teardowns and the delivery cutover preflight remove them after their own stop.
