---
"@cotal-ai/tmux": patch
---

A tmux-runtime seat handle now acts only on the tmux server that opened its window. After that server restarts, the seat's status reads `exited`, its exit wait resolves, and stop and interrupt no longer type into or close the window that reuses its ids on the new server.
