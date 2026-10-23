---
"@cotal-ai/cli": patch
---

A `cotal up` that loses the root to another whole-stack or maintenance command now refuses with `LIFECYCLE_BLOCKED`, names that command's pid, and gives a next step, as `cotal down` already did. It used to exit 3 with an unconfirmed outcome and a bare "maintenance lock is held by a live owner".
