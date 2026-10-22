---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal down --preserve-state` on a stack with no manager, such as one started with `--no-manager`, now refuses `TARGET_UNAVAILABLE` (exit 2) before it stops anything, and names `cotal up` to start the manager first. It used to stop the delivery daemon, wait about 20 seconds on a manager that never ran, end with an unknown outcome and leave the broker running. A machine-home `up --no-manager` summary names both steps.
