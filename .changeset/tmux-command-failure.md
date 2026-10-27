---
"@cotal-ai/tmux": patch
---

The tmux driver's session start, window selection, text send and key send keep tmux's own report when they fail. A refused `new-session`, a missing window and a missing pane used to throw only Node's `Command failed` line, because those four calls discarded stderr. The error now says `tmux: couldn't <operation>` and keeps the original error, including tmux's stderr, as its cause. `TmuxRuntime.spawn` carries that text in its refusal. A successful send, key and selection is unchanged, and a key still runs only on the server pid it was given.
