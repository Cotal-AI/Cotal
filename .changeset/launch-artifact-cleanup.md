---
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/pi": patch
"@cotal-ai/manager": patch
"@cotal-ai/seat": patch
"@cotal-ai/cli": patch
---

Private launch files now have an owner. The Claude persona file, the Claude shared-server MCP config file and the pi persona file are listed on the new `LaunchSpec.artifacts`, and the launcher removes them once it has proved the agent process gone: the manager does this on normal exit, stop and a failed launch (on tmux, cmux, orca and herdr by polling the seat's status and waiting for the runtime's exit proof), and the foreground `cotal spawn` does it when its child exits. A pty seat's custody record lists the files, so a manager that adopts or reaps the seat after its launching manager was killed removes them. A batch resume removes the files of specs it built and never launched. Both connectors now refuse a bad model, prompt or launch option before writing anything. A spawn that throws is not proof that nothing started, so its files stay for the OS temp reaper, as do those of a killed launcher with no custody record. The docs now say that owner-private means any process running as the same user can read the file while it exists.
