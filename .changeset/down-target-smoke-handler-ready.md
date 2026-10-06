---
"@cotal-ai/cli": patch
---

The `down-target` smoke now waits for its planted legacy manager to report that its SIGTERM handler is installed before `cotal down` signals it, with a 20 second bound. A fixed 100ms delay stood in for that readiness, so on a loaded host the manager could die to Node's default SIGTERM action before its handler existed, leave its planted agent running, and fail the `--with-agents` and historical-destructive cells without `down` being at fault. Shipped behaviour is unchanged.
