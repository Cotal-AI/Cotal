---
"@cotal-ai/cli": patch
---

`cotal space delete` with a typed confirmation now refuses `CONFLICT` when a stream's message count
changed while the confirmation waited, naming each changed count. A message posted after the impact
was shown used to be deleted with the rest, because only the stream states and presence were
checked again.
