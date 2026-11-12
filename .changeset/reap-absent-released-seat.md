---
"@cotal-ai/manager": patch
---

Released seat adoption checks orphaned custody through the shared runtime reap guard. `adoptReleasedSeat` calls `requireRuntimeReap` so an absent custody record is refused before reaching the caller.
