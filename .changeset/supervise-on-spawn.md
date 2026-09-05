---
"@cotal-ai/runtime": minor
"@cotal-ai/manager": minor
---

`spawn({ supervise })` is a restart policy the manager enforces in place: `{ restarts, window? }`
(default `10m`) until the budget is spent, then the seat is retired and the next `turn` is L4002.
A policy this host cannot honour is refused at accept.
