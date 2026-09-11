---
"@cotal-ai/seat": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

The seat record pins the custodian's and the child's process start identity, and a new `reapSeat` signals only a process whose identity matches. It also pins the boot those pids belong to: a start token counts ticks since boot, so a record that outlived a reboot names pids that now belong to other processes, and such a record is refused rather than signalled. The manager records each seat's custody reference on its static slot and, when a successor terminalizes a crashed manager's lifecycle, reaps the orphaned seat process through the runtime's custody `reap` before retiring the lifecycle. A runtime without it refuses by name and the lifecycle stays held. The custody reference is reserved before the seat is launched and rides the slot's first durable row, so a manager that dies between the launch and the slot activation still leaves a seat its successor can address; `Runtime.spawn` takes that reserved reference and must honour it. The same reference rides the rollback object a failed spawn hands its `finally`, so a manager that launched a seat and then threw reaps it in-process instead of retiring the lifecycle and freeing the alias over a running seat. Every seat id is checked against the shape `seatId` mints before it is joined to the custody root, so a forged reference is refused rather than resolved to a path outside it.

`reserve` and `reap` are NOT on the core `Runtime` contract. They live on a manager-local `CustodialRuntime` that the built-in pty runtime implements, because a backend that delegates to an external surface (`tmux`, `cmux`, `orca`, `herdr`) owns no process to signal and no custody record to pre-mint against, so the methods would have no meaning for it rather than merely no implementation. `adopt` stays on the generic contract.

The two crash scenarios and the in-process rollback are three suites, `smoke:orphan-seat-reap`, `smoke:orphan-seat-spawn-window` and `smoke:orphan-seat-rollback`, because one command carrying them crossed the mutation-proof command timeout.
