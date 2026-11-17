---
"cotal-ai": patch
---

Bound Linux daemon service startup to 60 seconds so systemd restarts a hung daemon even after its updater stops observing readiness.
