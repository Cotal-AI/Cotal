---
"@cotal-ai/cli": patch
---

`chat` on a static mesh whose manager is registered but does not answer, such as one that crashed,
now refuses `TARGET_UNAVAILABLE` (exit 2) once the describe deadline passes, with `cotal status` as
the next step, as the run verbs do. It exited 3 `OPERATION_UNKNOWN` saying the outcome of
`chat-session-open` was unconfirmed, although an unanswered describe means the request was never
sent.
