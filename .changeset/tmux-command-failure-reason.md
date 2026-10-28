---
"@cotal-ai/tmux": patch
---

A refused `new-session`, `select-window`, or `send-keys` names tmux's own reason (`tmux: couldn't <operation>`, with the failed call kept as `cause`). A failure that writes no stderr, such as a missing `tmux` or a timed-out call, names Node's own message instead of an empty reason. A spawn refused before its window opens carries that text.
