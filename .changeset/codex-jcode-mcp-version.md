---
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
---

Report the Cotal release loaded by Codex's HTTP MCP server and Jcode's stdio MCP bridge in standard `serverInfo.version`, instead of `0.0.0`. The value comes from the bundled release, not a CLI installed on disk; updating files does not change the version reported by an already-running process.
