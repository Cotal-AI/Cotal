---
"@cotal-ai/cli": patch
---

Self-update waits for an in-flight step to finish without starting new work, removes its temporary scratch, and exits 129 on a terminal hangup, and on Linux a later self-update reclaims a populated reconciliation cache left by a kill once its updater and worker group have exited and every entry has been idle for 24 hours.
