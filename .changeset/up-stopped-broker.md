---
"@cotal-ai/cli": patch
---

`cotal up` on a stack whose broker process is stopped by a signal now refuses `TARGET_UNAVAILABLE` at once, naming that pid and `kill -CONT <pid>`, before it writes the stack journal. It used to wait about 20 seconds, end `OPERATION_UNKNOWN` without naming the stop, and record the stopped broker's readiness as ready again.
