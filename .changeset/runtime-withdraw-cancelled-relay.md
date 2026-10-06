---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

A workflow run that cancels a branch now withdraws what that branch relayed to a seat. The manager serves the reserved `cancel` (SPEC 13.6 item 4) for a turn it relays: the caller's own goal moves to `cancelling`, leaves `turn-pending` and ends `cancelled`, and a later yield of it is answered with that terminal. A goal that already ended is refused with its cached outcome, and one the manager does not relay is refused unchanged. The run sends it when a cancelled `turn`, `ask` attempt or escalated `checkpoint` unwinds, and its cancellation sweep sends it again for a process that died first. Before this, a race loser's turn stayed on the seat: the seat could still pull and answer it, and because a seat is shown one turn at a time, the run's next turn to that seat waited behind it until its deadline. The hosted run's credential carries the new `cancel` row, and the manager's cluster document moves to revision 23.
