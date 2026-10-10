---
"@cotal-ai/tmux": patch
---

The tmux driver's `closeWindow`, `closeWindowIfHeld` and `closePane`, and so the tmux runtime's stop and reap and the tmux `TerminalLayout`'s `close`, now read a target as already gone only from the start of tmux's own `can't find window: `, `can't find session: ` or `can't find pane: ` report, and throw on any other failure. Before, the phrase could match anywhere in stderr or the error message, so a close that failed on a missing socket or an unsafe socket directory, with one of those words in the socket path or the target, returned as a finished close, or for `closeWindowIfHeld` as a window it did not hold, while the window kept running.
