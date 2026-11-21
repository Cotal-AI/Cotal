---
"@cotal-ai/cli": patch
---

`cotal completion uninstall bash` removes the managed integration even when a standalone Bash comment names the completion script. It preserves the comment and still refuses when the startup file may use the script outside the managed block.
