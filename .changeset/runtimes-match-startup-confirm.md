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

The watch's screen reads, and the Orca and Herdr terminal lookups around them, time out after one second, and no read starts once the 15 seconds are up, so a backend CLI that hangs fails the seat instead of stalling the manager.

A `confirm` prompt that is empty once ANSI codes and whitespace are removed, `""` included, is now refused before anything starts. The PTY runtime used to start the child first and then throw, which left the child running with no handle to stop it and its launch files on disk, and every runtime treated `""` as no prompt.
