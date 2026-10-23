---
"@cotal-ai/cmux": patch
---

The cmux runtime now refuses an env name that is not a shell identifier instead of writing it into a pane's launch script. The value of each env entry was quoted but the name was not, so a name such as `$(touch MARKER)X` ran as a command substitution when the pane started. A spawn with such a name is now a spawn refusal and a layout pane with one fails to open, before any launch script is written, which matches the check the tmux runtime already applies.
