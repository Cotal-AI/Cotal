---
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/pi": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Private launch files now have an owner. The Claude persona file, the Claude shared-server MCP config file and the pi persona file are listed on the new `LaunchSpec.artifacts`, and the launcher removes them once the agent process has exited: the manager does this on normal exit, stop and a failed launch (on tmux, cmux, orca and herdr, which cannot report a self-exit, when it stops the seat), and the foreground `cotal spawn` does it when its child exits. A spawn that throws removes them at once, and both connectors now refuse a bad model, prompt or launch option before writing anything. A seat the manager releases while it is still running keeps its files, and a launcher that is killed leaves them for the OS temp reaper. The docs now say that owner-private means any process running as the same user can read the file while it exists.
