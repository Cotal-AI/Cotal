---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A `nats-server` that `cotal up` started on the retained launcher and that exits before it answers
now fails the start as `OPERATION_FAILED`, exit 5, instead of an unconfirmed outcome. The message
names the file, its exit code or signal, and its log, and the next step is to read that log, then fix
the file or take it off PATH and run `cotal up` again. A broker that is still running when the wait
ends is still reported as unconfirmed.
