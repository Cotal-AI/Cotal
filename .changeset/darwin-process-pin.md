---
"@cotal-ai/workspace": patch
---

On macOS, a process identity pin now records the process start in microseconds through the bundled
binding, in place of the `ps -o lstart` start date, which has only second precision and could not
tell apart a pid reused within the same second. A pin an earlier release wrote still verifies with
the `ps` reader it was written with, so `down` after an upgrade stops a stack the earlier release
started. The process group and stopped-process readers that the service stop and the stack's broker
checks use now answer on macOS too, and a failed macOS group read throws rather than reading as empty.
