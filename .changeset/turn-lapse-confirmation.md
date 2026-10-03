---
"@cotal-ai/runtime": patch
---

A run's `turn` and `wait(down)` no longer read a seat as down from one presence read that misses its row. A seat's presence row expires 6 seconds after its last heartbeat, and a seat whose connector stalls longer than that, under host load or across a reconnect, renews the same incarnation's row once it resumes. On a loaded host one such gap failed the turn with L4002 (`lapsed`) while the seat kept working, and the run threw away the sibling branches of a `parallel` with it. A lapsed row now counts as the death only after it has stayed absent for 30 seconds. A row held by a different incarnation of the same name (`superseded`) still counts at once, and a seat that really died is still reported as L4002, about 30 seconds later than before.
