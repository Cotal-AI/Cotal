---
"@cotal-ai/manager": patch
"@cotal-ai/tmux": patch
"@cotal-ai/core": patch
---

Recover an ordinary resume whose coordinator and manager were both lost after the retained agents launched. The coordinator journals `resume-active` only after the manager's launch returns, so a crash in between left `resume-intent` behind a live agent, and the replacement manager refused it as `already live and this runtime cannot authoritatively adopt it`, leaving the journal degraded and the agent owned by nobody. On a static mesh the replacement manager now reads the seat reference the lost manager recorded on that agent's slot, reaps the seat through its runtime, waits for the principal to leave presence, and launches it again. A live principal with no such record, or one that stays live after the reap, is still refused. Tmux handles now carry a reference bound to the tmux server, window and pane, and the tmux runtime can reap by it, so a successor manager also closes the window of a tmux seat it retires instead of leaving it running. The reap closes that window even when the agent's pane already exited, since `remain-on-exit` or a second pane keeps the window open, and refuses a pane or window that has moved out of the session.
