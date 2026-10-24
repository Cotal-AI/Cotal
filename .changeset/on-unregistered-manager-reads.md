---
"@cotal-ai/cli": patch
---

`ps --on`, `stop --on` and `models --on` with an id that names no registered manager now refuse at once on a static or open mesh, as `spawn --on` does: `TARGET_NOT_FOUND` naming the managers that run, with `--on <id>` or no `--on` as Next, or `TARGET_UNAVAILABLE` when none runs. They used to wait out the 10 s describe deadline and report the id as a manager that did not answer.
