---
"@cotal-ai/workspace": patch
---

On Windows, publishing a process record no longer fails when another handle briefly holds the old pidfile or identity pin open. Windows refused the rename with `EPERM`, so a manager could exit right after boot and `cotal up` reported the control plane degraded (#4168). Each rename of a record now retries `EPERM`, `EACCES` and `EBUSY` on Windows, as graceful-fs does, with a backoff growing from 0 to 100 ms and at most 10 s of waiting in total. A refusal that lasts longer still throws, and so does any other error or any error on another platform.
