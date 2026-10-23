---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

When a root's controller stack runs under another `COTAL_HOME`, `status` and `up` now say so, name the
Cotal home in use and tell the operator to run with the one the stack was started under. `status`
said to start the stack with `cotal up`, and `up` refused its own members as legacy pidfile-owned
processes with no next step.
