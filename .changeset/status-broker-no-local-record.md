---
"@cotal-ai/cli": minor
---

`cotal status` reports when a broker has no local process record instead of calling it not started. The broker connection is checked separately, and JSON reports the missing record as `not-recorded` without an inferred PID.
