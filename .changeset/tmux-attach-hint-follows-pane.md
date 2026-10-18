---
"@cotal-ai/tmux": patch
---

The tmux seat's attach hint now names the seat's pane. It printed `tmux select-window -t @N` with the window id and name from spawn, so after a `swap-pane`, `join-pane`, `move-pane` or `break-pane` it selected whatever pane then sat in that window. It now prints `tmux select-window -t %N \; select-pane -t %N`, which selects the window holding the pane and makes the seat its active pane, as the handle's status and exit tracking already follow the pane. Selecting the pane also unzooms a window zoomed on another pane, so a seat joined or moved into such a window is shown.
