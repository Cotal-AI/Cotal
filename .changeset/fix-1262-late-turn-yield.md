---
"@cotal-ai/manager": patch
---

A late `turn-yield` after the deadline deny has committed is told the turn ended `failed`, never `not-found`.

The deny itself held: first-terminal-wins still refused a success over it. What failed was the diagnostic. `commitTurnDeadline` deletes the pending entry (its idempotency latch) *before* the terminal CAS, then remembers the settled answer only after. A yield in that window, or after a concurrent sweep dropped `turnAcceptances.settled`, heard `no pending turn` — which a seat reads as an addressing fault, not "the run moved on". The durable terminal is the answer the run already has; the yield now reads it when the in-memory settled field is missing, and the sweep no longer wipes an unsettled acceptance the moment pending is empty.
