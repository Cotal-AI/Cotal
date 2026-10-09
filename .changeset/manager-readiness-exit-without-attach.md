---
"@cotal-ai/manager": patch
---

A launch on a runtime that cannot stream its terminal (tmux, cmux, orca, herdr) whose process dies before it joins the mesh is now reported as exited on launch and its seat is freed. Before, the readiness wait had no exit signal on those runtimes, so it reported the launch as uncertain after the full readiness window and kept the dead seat managed. While a launch waits, the manager asks the runtime for the seat's status every second and once more when the readiness window closes, so a window shorter than a second is covered too. It confirms an exit with the runtime's `waitForExit`, the same proof the exit watch uses. The failure carries no last output, because these runtimes stream none.
