---
"@cotal-ai/seat": patch
---

A seat custodian whose log refuses the oom-preference line no longer exits with its child still running and no seat record. That line, the unattended line and the exit-record failure line now go through the custodian's one guarded log writer, so the unattended line also reaches stderr when the custodian has no log.
