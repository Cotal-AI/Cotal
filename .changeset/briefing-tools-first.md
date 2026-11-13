---
"@cotal-ai/connector-core": patch
---

Tell agents in their briefing to use their mesh tools rather than the cotal command line. Workflow runs are pointed at `cotal_run` instead of `cotal run start`, and `cotal_spawn` drops the unaudited-pin command-line recovery hint.

