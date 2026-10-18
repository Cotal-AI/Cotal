---
"@cotal-ai/tmux": patch
---

The tmux terminal layout now refuses a multi-pane tab with no `split` before it writes a launch script or opens a window. Before this, `open()` started the first pane in a new window and then threw, so the caller got an error with no ref while the window and its command kept running, and every retry left another one.
