---
"cotal-ai": patch
---

Daemon setup recovers when no agent application was available.
After one is installed, running setup again restarts an idle hosted Manager under its seat-preservation fence and reads application availability again. A Manager with active seats stays running and reports the seat cause. Missing-application remedies name the applications to install.

Updating Cotal succeeds when a running machine daemon has no recorded user service. The update reports its PID and version and leaves it running.
