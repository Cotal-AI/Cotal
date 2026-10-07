---
"@cotal-ai/core": patch
"@cotal-ai/seat": patch
"@cotal-ai/tmux": patch
"@cotal-ai/cmux": patch
"@cotal-ai/orca": patch
"@cotal-ai/herdr": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

The tmux, cmux, Orca and Herdr runtimes now honour `LaunchSpec.confirm` as the PTY runtime does. Each reads its pane, presses Enter once when the declared prompt is on screen, and ends the seat with `Cotal startup confirmation failed: prompt "<prompt>" did not appear within 15000ms.` in the manager's log when it never appears. They used to press Enter five times on a one-second timer whatever the screen showed, so a dialog shown before the declared prompt was answered with its default. Core exports the shared `confirmWatch` they use.

Each backend call the watch makes times out after one second: the screen read, the terminal lookup, the Enter, and the close that ends a failed seat. A call that times out is killed with SIGKILL, because Node waits for a timed-out child to exit and a CLI that handles SIGTERM would keep the manager blocked past the timeout. The status probes and other CLI calls that share those helpers are killed the same way when they time out. No read starts once the 15 seconds are up, so a backend CLI that hangs fails the seat instead of stalling the manager. The tmux watch ends a failed seat by closing the seat's pane in whichever window holds it now, so a pane swapped into the seat's first window survives. It reads, presses Enter and closes only on the tmux server that opened the seat's window, so after a tmux restart it never types into or closes a new pane that reuses the seat's pane id.

A `confirm` prompt that is empty once ANSI codes and whitespace are removed, `""` included, is now refused before anything starts, and its launch files are removed. The PTY runtime used to start the child first and then throw, which left the child running with no handle to stop it and its launch files on disk, and every runtime treated `""` as no prompt.
