---
"@cotal-ai/cli": patch
---

A repeated `cotal down --with-agents --yes` now reports that the stack is not running and exits 0 when the stack's last completed `down` already took `--with-agents`, and so does `--with-agents` on a root that never started a stack. It used to refuse with `LIFECYCLE_BLOCKED` and ask to start the stack first. After a `down` without `--with-agents` it still refuses, because agents that run outside the manager may remain.
