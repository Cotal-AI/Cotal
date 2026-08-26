---
"@cotal-ai/connector-jcode": patch
---

The jcode connector now handles macOS and BSD process-exit races during private-instance teardown
without hiding operational `ps` failures. A failed per-PID inspection is treated as a vanished
process only after an independent PID probe proves it no longer exists.
