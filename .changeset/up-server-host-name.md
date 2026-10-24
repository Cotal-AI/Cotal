---
"@cotal-ai/cli": patch
---

`cotal up --server` with a host name such as `localhost` is now refused `USAGE_INVALID` in every folder, with an example on `127.0.0.1` and your port. An unprepared folder used to start and record it, while a prepared folder refused it with no next step.
