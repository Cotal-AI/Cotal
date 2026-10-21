---
"@cotal-ai/cli": patch
---

Complete declared flags while the current shell word is `--`. Treat it as an end-of-options marker only after the shell commits that word. Keep aliases, subcommand flag scopes and positional completion. Stop offering options or option values after a committed separator, and stop offering option names as the value of another option.
