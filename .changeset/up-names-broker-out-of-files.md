---
"@cotal-ai/cli": patch
---

When `up` ran under a low open-file limit, the manager could exit before readiness with only "Can't reach NATS … Run: cotal up" in its log, while the broker's log recorded that it ran out of open files, and the next `up` reused that starved broker and failed again. `up` now names the broker's log and that cause when a member other than the broker fails readiness, and says to stop the stack with `cotal down --yes`, raise `ulimit -n`, then run `cotal up`.
