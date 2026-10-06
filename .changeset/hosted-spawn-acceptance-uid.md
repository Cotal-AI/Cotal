---
"@cotal-ai/manager": patch
---

A spawn accepted by a participant manager whose host enrolls its agents now names the lifecycle UID the agent runs at. The manager used to reply the acceptance with its own provisional UID before the host picked the real one, so a caller that addressed the agent by its acceptance was refused `expired`. On that arm the acceptance now waits for the host's enrollment answer, and a host refusal refuses the spawn without binding a goal.
