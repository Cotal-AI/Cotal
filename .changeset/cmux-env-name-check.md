---
"@cotal-ai/cmux": patch
---

The cmux runtime and terminal provider now refuse an env var name that is not a shell identifier, as the tmux runtime does, before writing the pane's launch script. A name such as `$(touch MARKER)X` used to be written into the script unquoted, so bash ran the substitution when the pane started. A cmux spawn with such a name is now a spawn refusal. A multi-pane tab refused at a later pane, or for a missing split, now removes the launch scripts it already wrote for the earlier panes, which held their env.
