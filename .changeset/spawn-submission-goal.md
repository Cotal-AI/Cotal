---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Retain a published spawn request's goal id when the caller deadline ends before acceptance is observed. Report the submission as unknown with same-caller goal-result readback instead of a plain failed spawn, without resubmitting or changing persona numbering.
