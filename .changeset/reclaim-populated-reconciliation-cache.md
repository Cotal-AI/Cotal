---
"@cotal-ai/cli": patch
---

While `cotal update --self` installs a newer release, a terminal hangup during package staging, replacement or reconciliation waits for the step in progress to finish without starting the next step, removes its temporary scratch, and exits 129, and on Linux a later `cotal update --self` reclaims Node compile-cache scratch holding a populated reconciliation cache once its recorded updater and worker group have exited and every entry has been idle for 24 hours.
