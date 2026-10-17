---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
---

A Claude Code session that Cotal launched now refuses the `cotal_*` tools of every MCP server other than its local Cotal server. Claude Code loads connected-account connectors in a spawned session by default, so a hosted Cotal connector beside the plugin let one session join the mesh twice under two names. The plugin's `PreToolUse` hook now denies those calls with the reason, and decides in the hook process, so the refusal holds when the control socket is down. A session Cotal did not launch keeps the hosted connector. `runHookRelay` takes an optional answer that settles an event in the hook process before the control socket is resolved.
