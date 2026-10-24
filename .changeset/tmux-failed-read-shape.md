---
"@cotal-ai/tmux": patch
---

A failed tmux pane capture or session-name read now throws the same shape as the driver's other queries. When `capture-pane` fails on a pane that is still running, the error reads `tmux: couldn't capture pane <id>:` instead of a bare `Command failed`. The session-name read no longer nests `Error:` in its text or lets tmux's stderr reach the caller's terminal. Both carry tmux's stderr in the message and keep the failed call as `cause`.
