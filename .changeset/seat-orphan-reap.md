---
"@cotal-ai/seat": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

A seat custodian now exits once its child has exited, after a short linger for a late adopter, and forgets its record; before, every custodian outlived its child forever. The seat record pins the custodian's and the child's process start identity, and a new `reapSeat` signals only a process whose identity matches. The manager records each seat's custody reference on its static slot and, when a successor terminalizes a crashed manager's lifecycle, reaps the orphaned seat process through the runtime's new `reap` before retiring the lifecycle. A runtime without `reap` refuses by name and the lifecycle stays held. The custody reference is minted by the runtime's new `reserve` before the seat is launched and rides the slot's first durable row, so a manager that dies between the launch and the slot activation still leaves a seat its successor can address; `Runtime.spawn` takes that reserved reference and must honour it. Every seat id is checked against the shape `seatId` mints before it is joined to the custody root, so a forged reference is refused rather than resolved to a path outside it. The crash-inside-the-spawn-window case is its own suite, `smoke:orphan-seat-spawn-window`, because one command carrying both scenarios crossed the mutation-proof command timeout.
