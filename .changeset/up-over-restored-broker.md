---
"@cotal-ai/cli": patch
---

On a legacy root, a bare `cotal up`, or `cotal up --server` with the same address, while a committed restore's broker ran exited 3, outcome unknown, with "a commit-token handoff needs a manager-committed resume or restore, not active", and left the restore journal degraded until another `up` repaired it. It now refuses `CONFLICT`, exit 2, before it touches the journal, naming the broker's PID, with `cotal down`, then `cotal up` as the next step, as `cotal up -f` does.
