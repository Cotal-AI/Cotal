---
"@cotal-ai/cli": patch
---

`cotal up -f` after a restore exited 3, outcome unknown, with "active listener ownership is alive; refusing ordinary startup" while the restored stack ran, and with an instruction to relaunch with bare `cotal up` once it was stopped, though `up -f` boots a fresh mesh and starts only after the restore is retired. It now refuses before anything starts. While the restored broker runs, the refusal is `CONFLICT`, exit 2, naming its PID, with `cotal down`, `cotal backup cleanup-fallback <attempt> --yes` and `cotal up -f <manifest>` as the next steps. Once that stack is stopped, it is `LIFECYCLE_BLOCKED`, exit 2, naming the cleanup.
