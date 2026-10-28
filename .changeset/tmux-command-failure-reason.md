---
"@cotal-ai/tmux": patch
---

A refused `new-session`, `select-window`, or `send-keys` names tmux's own reason (`tmux: couldn't <operation>`, with the failed call kept as `cause`), instead of only Node's `Command failed` line. A spawn refused before its window opens carries that text.
