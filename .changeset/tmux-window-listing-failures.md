---
"@cotal-ai/tmux": patch
---

The tmux driver's `windowAlive`, `windowAliveRef`, `listWindows` and `windowRefs`, and the tmux `TerminalLayout`'s `refs`, now throw when tmux cannot be queried. Before, a refused socket or a failing tmux binary read as no window, so a caller could not tell a live window from a closed one. Only a server that is not running reads as no windows, as `windowSessions` already did. A missing socket is a failed query, because a live server whose socket was removed reports it the same way. No server running is read only from the start of tmux's own `no server running on <socket>` report, so a socket path that contains those words no longer turns a failed query into absence, here or in `paneState`, `paneWindow` and `serverPid`. The session-scoped helpers now match a session by its exact name.
