---
"@cotal-ai/tmux": patch
---

The tmux seat's attach hint now names the seat's pane. It printed `tmux select-window -t @N` with the window id and name from spawn, so after a `swap-pane`, `join-pane`, `move-pane` or `break-pane` it selected whatever pane then sat in that window. It now prints `tmux select-window -t %N`, which tmux resolves to the window holding the pane, as the handle's status and exit tracking already do.
