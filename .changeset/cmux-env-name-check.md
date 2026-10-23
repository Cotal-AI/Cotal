---
"@cotal-ai/cmux": patch
---

The cmux runtime now refuses an env name that is not a shell identifier instead of writing it into a pane's launch script. The value of each env entry was quoted but the name was not, so a name such as `$(touch MARKER)X` ran as a command substitution when the pane started. A spawn with such a name is now a spawn refusal and a layout pane with one fails to open, before that pane's launch script is written, which matches the check the tmux runtime already applies. A layout tab that does not open, because a later pane is refused, a split is missing or the cmux command fails, now removes the launch scripts already written for its earlier panes. Those scripts hold the panes' env and stayed on disk.
