---
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/pi": patch
"@cotal-ai/manager": patch
"@cotal-ai/seat": patch
"@cotal-ai/cli": patch
"@cotal-ai/tmux": patch
"@cotal-ai/cmux": patch
"@cotal-ai/herdr": patch
"@cotal-ai/orca": patch
---

Private launch files now have an owner. The Claude persona file, the Claude shared-server MCP config file and the pi persona file are listed on the new `LaunchSpec.artifacts`, and the launcher removes them once it has proved the agent process gone. On a pty seat the seat's custodian removes them when it sees the agent exit, so they go on normal exit, stop and the custodian's unattended timeout even when the launching manager was killed, and a reap that proves the seat gone removes them when the custodian was killed first. A removal that fails stays on the custody record until a reap removes it, and that reap uses the temp dir the launch wrote to, so a successor with a different `TMPDIR` still removes them. Each directory name carries a random per-launch identity, so a stale path can never name a later launch's directory. Losing the custodian's connection no longer counts as the agent's exit. A pty launch refused before any process started removes them at once. On tmux, cmux, orca and herdr the manager removes them by polling the seat's status and waiting for the runtime's exit proof, and tries a removal that fails again until it succeeds; the foreground `cotal spawn` removes them when its child exits. Those runtimes now throw the new core `SpawnRefused` for an unsafe name, an unreachable backend or (herdr) a missing working directory, refused before any process starts, and the manager removes the files at once. A batch resume removes the files of specs it built and never launched. Both connectors now refuse a bad model, prompt or launch option before writing anything. Any other spawn that throws is not proof that nothing started, so its files stay for the OS temp reaper, as do those of a killed launcher on a runtime without custody. The docs now say that owner-private means any process running as the same user can read the file while it exists.
