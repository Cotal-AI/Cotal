---
"@cotal-ai/tmux": patch
---

A tmux-runtime seat handle's `stop()` and `interrupt()` now act on the seat's own pane wherever tmux has moved it. They used to target the window the seat opened in, so after `swap-pane` a stop or interrupt hit the unrelated pane that now sat there while the seat kept running, and after `join-pane` a hard stop did nothing. A stop now kills only the seat's pane, so other panes split into its window stay open.
