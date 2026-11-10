---
"cotal-ai": patch
---

Daemon setup discovers newly installed agent applications when run again.
An idle hosted Manager restarts under its seat-preservation fence before setup reads application availability again. A Manager with active seats stays running and reports the seat cause. Missing-application remedies name the applications to install.

Updating Cotal succeeds when a running machine daemon has no recorded user service. The update reports its PID and version and leaves it running.
