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

A `confirm` prompt that is empty once ANSI codes and whitespace are removed is now refused before anything starts. The PTY runtime used to start the child first and then throw, which left it running with no handle to stop it.
