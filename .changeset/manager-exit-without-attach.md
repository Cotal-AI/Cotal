---
"@cotal-ai/manager": patch
---

A seat on a runtime that cannot stream its terminal (tmux, cmux, orca, herdr) and exits on its own is now freed once the runtime proves the exit. Before, it stayed managed and held a capacity slot until someone stopped it. The manager asks the runtime for the seat's status every five seconds and confirms an exit with the runtime's `waitForExit`, the same proof the launch-file cleanup already used. A failed resume whose stop was not proved in time is freed the same way once its exit is proved. A runtime that can neither stream nor prove an exit now logs that its seats stay managed until stopped.
