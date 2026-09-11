---
"@cotal-ai/cli": patch
---

Warn when `cotal up --detach` is launched by a systemd `Type=oneshot` unit with
`RemainAfterExit=yes`, because that unit observes only the launcher's successful exit and can remain
active after the detached stack dies. Document a foreground long-running unit, component-health
checks, and split broker/manager monitoring.
