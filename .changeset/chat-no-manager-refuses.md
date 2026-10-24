---
"@cotal-ai/cli": patch
---

`chat` on a static mesh with no manager running now refuses `TARGET_UNAVAILABLE` (exit 2) at once
and names bare `cotal up`, as the run verbs do. It waited out the 10-second describe deadline and
exited 3 `OPERATION_UNKNOWN`, saying the outcome of `chat-session-open` was unconfirmed and
describing the ep.v1 rail, although no session had been asked for.
